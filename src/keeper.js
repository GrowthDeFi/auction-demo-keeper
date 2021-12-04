/* eslint-disable complexity */
/* eslint-disable no-unused-vars */
import oasisDexAdaptor from './dex/oasisdex.js';
import Config from './singleton/config.js';
import network from './singleton/network.js';
import Clipper from './clipper.js';
import { ethers, BigNumber } from 'ethers';
import UniswapAdaptor from './dex/uniswap.js';
import Wallet from './wallet.js';
import { clipperAllowance, checkVatBalance, daiJoinAllowance } from './vat.js';
import fs from 'fs';
import dog from '../abi/dog.json';
import DssCdpManager from '../abi/DssCdpManager.json';
import { Transact, GeometricGasPrice } from './transact.js';
import { sendTelegramMessage, escapeHTML, reportError } from './telegram.js';

/* The Keeper module is the entry point for the
 ** auction Demo Keeper
 * all configurations and intitalisation of the demo keeper is being handled here
 */

const setupWallet = async (network, passwordPath, JSONKeystorePath) => {
  if (passwordPath && JSONKeystorePath) {
    const wallet = new Wallet(passwordPath, JSONKeystorePath);
    const jsonWallet = await wallet.getWallet();
    console.log('Initializing ', jsonWallet);
    const signer = new ethers.Wallet(jsonWallet, network.provider);
    return signer;
  } else {
    return null;
  }
};

let _this;
export default class keeper {
  _clippers = [];
  _wallet = null;
  _uniswapCalleeAdr = null;
  _uniswapLPCalleeAdr = null;
  _oasisCalleeAdr = null;
  _gemJoinAdapters = {};
  _activeAuctions = null;
  _processingFlags = {};

  constructor(configPath, walletPasswordPath, walletKeystorePath) {
    let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    Config.vars = config;
    network.rpcURL = config.rpcURL;
    this.walletPasswordPath = walletPasswordPath;
    this.walletKeystorePath = walletKeystorePath;
    _this = this;
  }

  // Check if there's an opportunity in Uniswap & OasisDex to profit with a LIQ2.0 flash loan
  async _opportunityCheck(collateral, oasis, uniswap, clip) {
    if (this._processingFlags[collateral]) {
      console.debug('Already processing opportunities for ' + collateral.name);
    } else {
      console.log('Checking auction opportunities for ' + collateral.name);
      this._processingFlags[collateral] = true;
    }

    if (oasis)  // Oasis liquidity check doesn't depend on auction lot size
      await oasis.fetch();

    this._activeAuctions = await clip.activeAuctions();
    // Fetch the orderbook from OasisDex & all the active auctions
    console.log(`${collateral.name} Active auctions qty: ${this._activeAuctions.length}`);

    try {
      // Look through the list of active auctions
      for (let i = 0; i < this._activeAuctions.length; i++) {
        let auction = this._activeAuctions[i];

        // Redo auction if it ended without covering tab or lot
        if (this._wallet) {
          const redone = await clip.auctionStatus(auction.id, this._wallet.address, this._wallet);
          if (redone)
            continue;
        }

        const decimals9 = BigNumber.from('1000000000');
        const decimals18 = ethers.utils.parseEther('1');
        const decimals27 = ethers.utils.parseEther('1000000000');

        let minProfitPercentage = ethers.utils.parseEther(Config.vars.minProfitPercentage);
        let priceWithProfit = auction.price.div(minProfitPercentage).mul(decimals18);

        // Determine configured lot sizes in Gem terms
        let minLotDaiValue = ethers.utils.parseEther(Config.vars.minLotDaiValue).mul(decimals18);
        let minLot = minLotDaiValue.div(auction.price.div(decimals9));
        let maxLotDaiValue = ethers.utils.parseEther(Config.vars.maxLotDaiValue).mul(decimals18);
        let maxLot = maxLotDaiValue.div(auction.price.div(decimals9));

        //adjust lot based upon slice taken at the current auction price
        let slice18 = auction.lot.gt(maxLot) ? maxLot : auction.lot;
        let owe27 = slice18.mul(auction.price).div(decimals18);
        let tab27 = auction.tab.div(decimals18);
        // adjust covered debt to tab, such that slice better reflects amount of collateral we'd receive
        if (owe27.gt(tab27) && slice18.gt(auction.lot)) {
          owe27 = tab27;
          slice18 = owe27.div(auction.price.div(decimals18));
        } else if (owe27.lt(tab27) && slice18.lt(auction.lot)) {
          let chost27 = clip._chost.div(decimals18);
          if (tab27.sub(owe27).lt(chost27)) {
            if (tab27.lte(chost27)) {
              // adjust the penultimate take to avoid partial lot on the final take
              owe27 = tab27.sub(chost27);
            } else {
              // adjust to chost
              owe27 = chost27;
            }

            slice18 = owe27.div(auction.price.div(decimals18));
          }
          if (slice18.gt(maxLot)) {  // handle corner case where maxLotDaiValue is set too low
            console.log(`Ignoring auction ${auction.id} whose chost-adjusted slice of ${ethers.utils.formatUnits(slice18)} exceeds our maximum lot of ${ethers.utils.formatUnits(maxLot)}\n`);
            continue;
          }
        }
        if (slice18.gt(auction.lot)) {
          // HACK: I suspect the issue involves interplay between reading price from the abacus and not having multicall.
          slice18 = auction.lot;
        }
        let lot = slice18;
        if (lot.lt(minLot)) {
          console.log(`Ignoring auction ${auction.id} while slice is smaller than our minimum lot\n`);
          // slice approaches lot as auction price decreases towards owe == tab
          continue;
        }

        // Find the minimum effective exchange rate between collateral/Dai
        // e.x. ETH price 1000 DAI -> minimum profit of 1% -> new ETH price is 1000*1.01 = 1010
        const calcMinProfit45 = owe27.mul(minProfitPercentage);
        const totalMinProfit45 = calcMinProfit45.sub(owe27.mul(decimals18));
        const minProfit = totalMinProfit45.div(decimals27);
        const costOfLot = priceWithProfit.mul(lot).div(decimals27);

        // Find the amount of collateral that maximizes the amount of profit captured
        let oasisDexAvailability;
        if (oasis)
          oasisDexAvailability = oasis.opportunity(priceWithProfit.div(decimals9));

        // Determine proceeds from swapping gem for Dai on Uniswap
        let uniswapProceeds;
        let minUniProceeds;
        if (uniswap) {
          uniswapProceeds = await uniswap.fetch(lot);
          minUniProceeds = Number(uniswapProceeds.receiveAmount) - Number(ethers.utils.formatUnits(minProfit));
        }

        const auctionSummary = `\n
          ${collateral.name} auction ${auction.id}

            Auction Tab:        ${ethers.utils.formatUnits(auction.tab.div(decimals27))} Dai
            Auction Lot:        ${ethers.utils.formatUnits(auction.lot.toString())}
            Configured Lot:     between ${ethers.utils.formatUnits(minLot)} and ${ethers.utils.formatUnits(maxLot)}
            Debt to Cover:      ${ethers.utils.formatUnits(owe27.div(decimals9))} Dai
            Slice to Take:      ${ethers.utils.formatUnits(lot)}
            Auction Price:      ${ethers.utils.formatUnits(auction.price.div(decimals9))} Dai

            Cost of lot:        ${ethers.utils.formatUnits(costOfLot)} Dai
            Minimum profit:     ${ethers.utils.formatUnits(minProfit)} Dai\n`;

        let liquidityAvailability;
        if (uniswap) {
          liquidityAvailability = `
            Uniswap proceeds:   ${uniswapProceeds.receiveAmount} Dai
            Less min profit:    ${minUniProceeds}\n`;
          console.log(auctionSummary + liquidityAvailability);
          if (Number(ethers.utils.formatUnits(costOfLot)) <= minUniProceeds) {
            //Uniswap tx executes only if the return amount also covers the minProfit %
            await clip.execute(
              auction.id,
              lot,
              auction.price,
              minProfit,
              Config.vars.profitAddr,
              this._gemJoinAdapters[collateral.name],
              this._wallet,
              uniswap._callee.address
            );
          } else {
            console.log('Uniswap proceeds - profit amount is less than cost.\n');
          }

        } else if (oasis) {
          liquidityAvailability = `
            Gem price with profit: ${ethers.utils.formatUnits(priceWithProfit.div(decimals9))}
            OasisDEXAvailability:  amt of collateral avl to buy ${ethers.utils.formatUnits(oasisDexAvailability)}\n`;
          console.log(auctionSummary + liquidityAvailability);
          //OasisDEX buys gem only with gem price + minProfit%
          if (oasisDexAvailability.gt(auction.lot)) {
            await clip.execute(
              auction.id,
              lot,
              auction.price,
              minProfit,
              Config.vars.profitAddr,
              this._gemJoinAdapters[collateral.name],
              this._wallet,
              oasis._callee.address
            );
          } else {
            console.log('Not enough liquidity on OasisDEX\n');
          }
        }

        this._activeAuctions = await clip.activeAuctions();
      }
    } catch (e) {
      console.error(e);
    } finally {
      this._processingFlags[collateral] = false;
    }
    //Check for any received tips from redoing auctions
    // FIXME - this will fire multiple times for each collateral type
    //await checkVatBalance(this._wallet);
  }

  // Initialize the Clipper, OasisDex, and Uniswap JS wrappers
  async _clipperInit(collateral) {
    this._uniswapCalleeAdr = collateral.uniswapCallee;
    this._uniswapLPCalleeAdr = collateral.uniswapLPCallee;
    this._oasisCalleeAdr = collateral.oasisCallee;
    this._gemJoinAdapters[collateral.name] = collateral.joinAdapter;

    // construct the oasis contract method
    const oasis = collateral.oasisCallee ? new oasisDexAdaptor(
      collateral.erc20addr,
      collateral.oasisCallee,
      collateral.name
    ) : null;

    // construct the uniswap contract method
    const uniswap = (collateral.uniswapCallee || collateral.uniswapLPCallee) ?
      new UniswapAdaptor(
        collateral.erc20addr,
        collateral.uniswapCallee ?
          collateral.uniswapCallee : collateral.uniswapLPCallee,
        collateral.name
      ) : null;

    // construct the clipper contract method
    const clip = new Clipper(collateral.name);

    // inititalize Clip
    await clip.init();

    // Initialize the loop where an opportunity is checked at a perscribed cadence (Config.delay)
    const timer = setInterval(() => {
      this._opportunityCheck(collateral, oasis, uniswap, clip);
    }, Config.vars.delay * 1000);
    return { oasis, uniswap, clip, timer };
  }

  async run() {
    { // telegram
      function interrupt(f) {
        process.on('SIGINT', f);
        process.on('SIGTERM', f);
        process.on('SIGUSR1', f);
        process.on('SIGUSR2', f);
        process.on('uncaughtException', f);
        process.on('unhandledRejection', f);
      }
      const network = Config.vars.network;
      await sendTelegramMessage('<i>LiquidationBot (' + network + ') Initiated</i>');
/*
      let interrupted = false;
      interrupt(async (e) => {
        if (!interrupted) {
          interrupted = true;
          console.error('error', e, e instanceof Error ? e.stack : undefined);
          const message = e instanceof Error ? e.message : String(e);
          await sendTelegramMessage('<i>LiquidationBot (' + network + ') Interrupted (' + escapeHTML(message) + ')</i>');
          process.exit(0);
        }
      });
*/
      setTimeout(async () => {
        await sendTelegramMessage('<i>LiquidationBot (' + network + ') Forced Reset</i>');
        setTimeout(() => process.exit(0), 3 * 1000);
      }, 24 * 60 * 60 * 1000);
    }
    this._wallet = await setupWallet(network, this.walletPasswordPath, this.walletKeystorePath);
    for (const name in Config.vars.collateral) {
      if (Object.prototype.hasOwnProperty.call(Config.vars.collateral, name)) {
        const collateral = Config.vars.collateral[name];

        //Check for clipper allowance
        if (this._wallet) {
          await clipperAllowance(collateral.clipper, this._wallet);
          await daiJoinAllowance(Config.vars.daiJoin, this._wallet);
        }

        /* The pair is the clipper, oasisdex and uniswap JS Wrappers
         ** Pair Variables definition
         * oasis : oasisDexAdaptor
         * uniswap : UniswapAdaptor
         * clip : Clipper
         * time : NodeJS.Timeout
         */
        this._clipperInit(collateral).then((pair) => {
          // add the pair to the array of clippers
          this._clippers.push(pair);
          console.log(`\n------------------ COLLATERAL ${collateral.name} INITIALIZED ------------------\n`);
        });
      }
    }
    {
      // taker parameters
      // minimum amount 1000 MOR
      // receiver 0x80F2dCC36D9548F97A14a3bF73D992FB614e45f4
      if (Config.vars.dog === undefined || Config.vars.cdpManager === undefined) return;
      console.log('Starting barker...');
      const barker = new ethers.Contract(
        Config.vars.dog,
        dog,
        network.provider
      );
      const manager = new ethers.Contract(
        Config.vars.cdpManager,
        DssCdpManager,
        network.provider
      );
      while (true) {
        try {
          const cdpi = Number(await manager.cdpi());
          for (let i = 1; i <= cdpi; i++) {
            const ilk = await manager.ilks(i);
            const urn = await manager.urns(i);

            const initial_price = await this._wallet.getGasPrice();
            const gasStrategy = new GeometricGasPrice(initial_price.add(BigNumber.from(Config.vars.initialGasOffsetGwei ?? 0).mul(1e9)).toNumber(), Config.vars.txnReplaceTimeout, Config.vars.dynamicGasCoefficient);
            let bark_transaction;
            try {
              bark_transaction = await barker.populateTransaction.bark(ilk, urn, this._wallet.address);
            } catch (error) {
              console.log(error.message);
            }
            console.log(`\nAttempting to bark at cdp ${i}`);
            try {
              const txn = new Transact(bark_transaction, this._wallet, Config.vars.txnReplaceTimeout, gasStrategy);
              const response = await txn.transact_async();
              if (response.hash != undefined) {
                console.log(`Cdp ${i} Bark Tx Hash ${response.hash}`);
                const provider = network.provider;
                { // telegram
                  const network = Config.vars.network;
                  const name = 'cdp #' + i;
                  const type = 'dog';
                  const address = Config.vars.dog;
                  const account = this._wallet.address;
                  const tx = response.hash;
                  const ADDRESS_URL_PREFIX = {
                    'bscmain': 'https://bscscan.com/address/',
                    'avaxmain': 'https://snowtrace.io/address/',
                  };
                  const TX_URL_PREFIX = {
                    'bscmain': 'https://bscscan.com/tx/',
                    'avaxmain': 'https://snowtrace.io/tx/',
                  };
                  const NATIVE_SYMBOL = {
                    'bscmain': 'BNB',
                    'avaxmain': 'AVAX',
                  };
                  const url = ADDRESS_URL_PREFIX[network] + address;
                  const accountUrl = ADDRESS_URL_PREFIX[network] + account;
                  const txUrl = TX_URL_PREFIX[network] + tx;
                  const txPrefix = tx.substr(0, 6);
                  const value = await provider.getBalance(account);
                  const balance = Number(ethers.utils.formatEther(value)).toFixed(4);
                  const lines = [];
                  lines.push('<a href="' + accountUrl + '">LiquidationBot</a>');
                  lines.push('<code>' + balance + ' ' + NATIVE_SYMBOL[network] + '</code>');
                  lines.push('<a href="' + url + '">' + type + '</a>.bark() at <a href="' + txUrl + '">' + txPrefix + '</a> for ' + name);
                  await sendTelegramMessage(lines.join('\n'));
                }
              }
            } catch (error) {
              { // telegram
                const network = Config.vars.network;
                await reportError(error, 'Failure', network);
              }
              console.error(error);
            }
          }
        } catch (error) {
          console.error(error);
        }
      }
    }
  }

  stop() {
    this._clippers.forEach((tupple) => {
      clearTimeout(tupple.timer);
    });
  }
}
