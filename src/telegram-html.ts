// Экранирование для Telegram parse_mode: 'HTML'.
// Обязательно для любого пользовательского текста (имена, сообщения в чате),
// иначе символы <, >, & могут сломать разметку или привести к ошибке отправки.
export function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}