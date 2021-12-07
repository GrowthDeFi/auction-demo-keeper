import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

export function escapeHTML(message) {
  return message
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const telegramBotApiKey = process.env['TELEGRAM_BOT_API_KEY'] || '';
const telegramBotChatId = process.env['TELEGRAM_BOT_CHAT_ID'] || '';

let lastTelegramMessage = {};

export async function sendTelegramMessage(message, key = '') {
  if (message !== lastTelegramMessage[key]) {
    console.log(new Date().toISOString());
    console.log(message);
    try {
      const url = 'https://api.telegram.org/bot'+ telegramBotApiKey +'/sendMessage';
      await axios.post(url, { chat_id: telegramBotChatId, text: message, parse_mode: 'HTML', disable_web_page_preview: true });
      lastTelegramMessage[key] = message;
    } catch (e) {
      console.error('FAILURE', e.message);
    }
  }
}

export async function reportError(e, type, detail) {
  const message = typeof e === 'object' && e !== null && 'message' in e ? e.message : String(e);
  if (message.includes('Cannot read property \'substr\' of undefined')) return;
  if (message.includes('SERVER_ERROR')) return;
  if (message.includes('Gateway timeout')) return;
  if (message.includes('502 Bad Gateway')) return;
  if (message.includes('internal error')) return;
  if (message.includes('Unknown Error')) return;
  if (message.includes('ETIMEDOUT')) return;
  if (message.includes('ESOCKETTIMEDOUT')) return;
  if (message.includes('header not found')) return;
  if (message.includes('handle request error')) return;
  if (message.includes('Too Many Requests')) return;
  if (message.includes('Could not find block')) return;
  if (message.includes('cannot query unfinalized data')) return;
  if (message.includes('invalid argument 0: hex string without 0x prefix')) return;
  await sendTelegramMessage('<i>LiquidationBot (' + escapeHTML(detail) + ') ' + escapeHTML(type) + ' (' + escapeHTML(message) + ')</i>');
}
