/**
 * Текст ошибок в конце строки — только для severity Error (то, что ломает
 * сборку). Встроенная настройка diagnostics_inline_text показывает самое
 * серьёзное замечание строки любого уровня, фильтра по уровню у него нет,
 * поэтому он выключен, а этот плагин рисует свой текст.
 */

const editor = getEditor();

const PREFIX = "error-lens:";
const ERROR = 1;

const uriByBuffer = new Map<number, string>();
let lastWidth = 0;

/**
 * Колонка текста, на которой сообщение должно заканчиваться. Ширина
 * viewport — вся панель вместе с колонкой номеров строк, поэтому вычитаем
 * её (цифры номера + значки) и запас, иначе текст переносится на новую строку.
 */
function rightEdgeColumn(lineCount: number): number | null {
  const viewport = editor.getViewport();
  if (!viewport) return null;
  const gutter = String(lineCount).length + 5;
  return Math.max(20, viewport.width - gutter - 2);
}

function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    return decodeURIComponent(uri.slice("file://".length));
  } catch (_e) {
    return uri.slice("file://".length);
  }
}

function utf8Length(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdbff) return 4; // старшая половина суррогатной пары
  if (code >= 0xdc00 && code <= 0xdfff) return 0; // младшая уже учтена
  return 3;
}

/**
 * Байтовые позиции начала каждой строки. Сообщение привязано к первому байту
 * строки (как рамки во встроенном markdown-плагине): padToColumn всё равно
 * рисует его у правого края, а привязка к концу строки «уезжает» при наборе.
 */
function lineStarts(text: string): number[] {
  const starts: number[] = [0];
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes += utf8Length(code);
    if (code === 10) starts.push(bytes);
  }
  return starts;
}

async function render(uri: string): Promise<void> {
  const path = uriToPath(uri);
  if (!path) return;
  const bufferId = editor.findBufferByPath(path);
  if (!bufferId) return; // 0 — буфер не открыт

  editor.removeVirtualTextsByPrefix(bufferId, PREFIX);

  const firstByLine = new Map<number, string>();
  for (const d of editor.getAllDiagnostics()) {
    if (d.uri !== uri || d.severity !== ERROR) continue;
    const line = d.range.start.line;
    if (!firstByLine.has(line)) firstByLine.set(line, d.message.split("\n")[0]);
  }
  if (firstByLine.size === 0) return;

  uriByBuffer.set(bufferId, uri);
  const starts = lineStarts(await editor.getBufferText(bufferId));
  const options: Record<string, unknown> = { fg: "diagnostic.error_fg" };
  const column = rightEdgeColumn(starts.length);
  if (column !== null) options.padToColumn = column; // выравнивание по правому краю

  for (const [line, message] of firstByLine) {
    if (line >= starts.length) continue;
    editor.addVirtualTextStyled(bufferId, PREFIX + line, starts[line], "    " + message, options, true);
  }
}

editor.on("diagnostics_updated", (data) => {
  render(data.uri).catch((e) => editor.debug(`error-lens: ${e}`));
});

// Ширина окна поменялась — пересчитать отступы до правого края.
editor.on("viewport_changed", (data) => {
  if (data.width === lastWidth) return;
  lastWidth = data.width;
  const uri = uriByBuffer.get(data.buffer_id);
  if (uri) render(uri).catch((e) => editor.debug(`error-lens: ${e}`));
});

editor.debug("error-lens: plugin loaded");
