/**
 * Новая строка ниже / выше текущей — курсор может стоять в любом месте
 * строки, отступ ставит обычный insert_newline (auto_indent языка).
 * Аналог Shift+Enter / «Start New Line Before Current» в Rider.
 */

const editor = getEditor();

function insert_line_below(): void {
  editor.executeActions([{ action: "move_line_end" }, { action: "insert_newline" }]);
}

function insert_line_above(): void {
  // На первой строке подняться некуда: разрываем строку в её начале
  // и возвращаемся на появившуюся пустую строку.
  if (editor.getPrimaryCursor()?.line === 0) {
    editor.executeActions([
      { action: "move_line_start" },
      { action: "insert_newline" },
      { action: "move_up" },
    ]);
    return;
  }
  editor.executeActions([
    { action: "move_up" },
    { action: "move_line_end" },
    { action: "insert_newline" },
  ]);
}

registerHandler("insert_line_below", insert_line_below);
registerHandler("insert_line_above", insert_line_above);
editor.registerCommand("Insert Line Below", "Новая строка ниже текущей", "insert_line_below");
editor.registerCommand("Insert Line Above", "Новая строка выше текущей", "insert_line_above");

editor.debug("new-line: plugin loaded");
