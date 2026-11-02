/**
 * История переходов как в Rider: Back/Forward ходят только по осмысленным
 * переходам, а не по каждому движению курсора (встроенная история Fresh
 * пишет любой скачок курсора дальше 50 байт или после паузы).
 *
 * Место запоминается:
 *   - перед переходом через обёртки nav_* (определение, реализация,
 *     использования, структура файла, строка, поиск, Live Grep, палитра);
 *   - при уходе из вкладки (buffer_deactivated) — по последней позиции
 *     курсора в ней.
 * Свои прыжки (nav_back / nav_forward) в историю не пишутся.
 */

const editor = getEditor();

interface Loc {
  bufferId: number;
  path: string;
  position: number; // байтовая позиция курсора
  line: number | null; // 0-based
}

const MAX = 100;
const back: Loc[] = [];
const fwd: Loc[] = [];
const lastPos = new Map<number, { position: number; line: number | null }>();
let suppressUntil = 0;

function current(): Loc | null {
  const bufferId = editor.getActiveBufferId();
  const path = editor.getBufferPath(bufferId);
  const cursor = editor.getPrimaryCursor();
  if (!path || !cursor) return null;
  return { bufferId, path, position: cursor.position, line: cursor.line };
}

// Одна и та же строка одного файла — одно место.
function same(a: Loc, b: Loc): boolean {
  if (a.path !== b.path) return false;
  if (a.line !== null && b.line !== null) return a.line === b.line;
  return a.position === b.position;
}

function push(stack: Loc[], loc: Loc): void {
  const top = stack[stack.length - 1];
  if (top && same(top, loc)) return;
  stack.push(loc);
  if (stack.length > MAX) stack.shift();
}

function record(loc: Loc | null): void {
  if (!loc || Date.now() < suppressUntil) return;
  push(back, loc);
  fwd.length = 0;
}

function jump(loc: Loc): void {
  suppressUntil = Date.now() + 500;
  if (editor.getBufferPath(loc.bufferId) === loc.path) {
    editor.showBuffer(loc.bufferId);
    editor.setBufferCursor(loc.bufferId, loc.position);
  } else {
    editor.openFile(loc.path, loc.line !== null ? loc.line + 1 : null, null);
  }
}

function step(from: Loc[], to: Loc[], emptyMessage: string): void {
  const cur = current();
  while (from.length > 0) {
    const target = from.pop()!;
    if (cur && same(target, cur)) continue;
    if (cur) push(to, cur);
    jump(target);
    return;
  }
  editor.setStatus(emptyMessage);
}

function nav_back(): void {
  step(back, fwd, "Navigation history: nothing to go back to");
}

function nav_forward(): void {
  step(fwd, back, "Navigation history: nothing to go forward to");
}

registerHandler("nav_back", nav_back);
registerHandler("nav_forward", nav_forward);
editor.registerCommand("Nav: Back", "Go back through meaningful jumps", "nav_back");
editor.registerCommand("Nav: Forward", "Go forward through meaningful jumps", "nav_forward");

// Обёртки: запомнить место и выполнить исходное действие.
// У каждого плагина своё JS-окружение. Какому плагину отдать действие из
// привязки клавиш, Fresh узнаёт только из registerCommand — без него ищет
// функцию в общем окружении и пишет «Action … is not defined as a global
// function». Поэтому каждая обёртка зарегистрирована и как команда.
function recordAndRun(action: string): void {
  record(current());
  editor.executeAction(action);
}

function nav_goto_definition(): void {
  recordAndRun("lsp_goto_definition");
}
function nav_goto_implementation(): void {
  recordAndRun("lsp_implementation");
}
function nav_find_references(): void {
  recordAndRun("lsp_references");
}
function nav_goto_symbol(): void {
  recordAndRun("goto_lsp_symbol");
}
function nav_goto_line(): void {
  recordAndRun("goto_line");
}
function nav_live_grep(): void {
  recordAndRun("open_live_grep");
}

registerHandler("nav_goto_definition", nav_goto_definition);
registerHandler("nav_goto_implementation", nav_goto_implementation);
registerHandler("nav_find_references", nav_find_references);
registerHandler("nav_goto_symbol", nav_goto_symbol);
registerHandler("nav_goto_line", nav_goto_line);
registerHandler("nav_live_grep", nav_live_grep);
editor.registerCommand("Nav: Go to Definition", "Go to definition, remembering the current place", "nav_goto_definition");
editor.registerCommand("Nav: Go to Implementation", "Go to implementation, remembering the current place", "nav_goto_implementation");
editor.registerCommand("Nav: Find References", "Find references, remembering the current place", "nav_find_references");
editor.registerCommand("Nav: Go to Symbol", "File structure, remembering the current place", "nav_goto_symbol");
editor.registerCommand("Nav: Go to Line", "Go to line, remembering the current place", "nav_goto_line");
editor.registerCommand("Nav: Live Grep", "Search the project, remembering the current place", "nav_live_grep");

editor.on("cursor_moved", (data) => {
  lastPos.set(data.buffer_id, { position: data.new_position, line: data.line });
});

editor.on("buffer_deactivated", (data) => {
  const path = editor.getBufferPath(data.buffer_id);
  const pos = lastPos.get(data.buffer_id);
  if (!path || !pos) return;
  record({ bufferId: data.buffer_id, path, position: pos.position, line: pos.line });
});

editor.debug("nav-history: plugin loaded");
