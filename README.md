# Настройки редактора Fresh

Конфигурация [Fresh](https://github.com/sinelaw/fresh) для работы с C#, приближенная к Rider.

## Состав

- `config.json` — раскладка `macos`, свои привязки клавиш, LSP для C#, настройки плагинов.
- `cheatsheet.md` — шпаргалка по клавишам.
- `lsp/roslyn-proxy.py` — прослойка между Fresh и `roslyn-language-server`. Обходит несовместимости между ними; что и почему, описано в начале файла.
- `plugins/` — свои плагины:
  - `nav_history.ts` — история переходов как в Rider (Ctrl+- / Ctrl+=) и обёртки навигации;
  - `new_line.ts` — новая строка ниже / выше (Shift+Enter / Ctrl+Shift+Enter);
  - `error_lens.ts` — текст ошибок (только Error) у правого края строки;
  - `new_folder.ts` — команда `New Folder`: создать папку без проводника;
  - `md_preview.ts` — `.md` в просмотрщике cmux (Ctrl+Shift+V);
  - `csharp_decompiled.ts` — декомпиляция для `csharp-ls` (запасной сервер).
- `themes/hc-diagnostics.json` — тема на основе `high-contrast`: цвета диагностики, комментариев, строк, полей.
- `types/`, `tsconfig.json` — типы API плагинов, создаёт сам Fresh. После обновления Fresh `git diff types/` показывает изменения API.

## Зависимости

- `brew install fresh-editor` (проверено на 0.5.4).
- `roslyn-language-server` (проверено на 5.13.0-1.26514.10):
  `dotnet tool install -g roslyn-language-server --version 5.13.0-1.26514.10 --add-source <nuget-mirror>`
- `/usr/bin/python3` — для прослойки.
- В `~/.zshrc`: `export VISUAL='fresh'` и `export EDITOR='fresh'`.

Пути в `config.json` абсолютные (`/Users/kanea/...`), на другой машине их нужно поправить.

## Применение изменений

`fresh` без файла подключается к фоновому серверу, который не перечитывает настройки. После правок:

```
Ctrl+Q
fresh --cmd daemon kill orchestrator
fresh
```
