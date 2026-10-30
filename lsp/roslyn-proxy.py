#!/usr/bin/env python3
"""LSP-прокси между Fresh и roslyn-language-server.

Fresh после «массовых» правок (автозакрытие скобок, замена по проекту,
перечитывание файла с диска) шлёт textDocument/didChange без range — целиком
новый текст. Протокол это разрешает, но roslyn-language-server 5.8 падает на
таком изменении (NullReferenceException в RangeToLinePositionSpan) и
перезапускается без открытых документов.

Прокси помнит текст каждого открытого документа и подставляет в такие
изменения range на весь старый текст. Остальные сообщения идут как есть.

Вторая проблема: Fresh запрашивает диагностику сразу после открытия файла,
пока Roslyn ещё грузит проекты, а workspace/diagnostic/refresh Roslyn не
шлёт — подчёркивания так и не появляются. Причина во Fresh: поддержку refresh
он объявляет под ключом workspace.diagnostic (так сериализует lsp-types 0.97),
а по спецификации LSP это workspace.diagnostics — Roslyn её не видит. Поэтому, когда Roslyn сообщает об
изменении решения (projectInitializationComplete, semanticTokens/refresh),
прокси с задержкой сам шлёт Fresh workspace/diagnostic/refresh и не
пропускает ответ Fresh на него к серверу.

Третья: семантическая подсветка Roslyn использует свои типы токенов
(recordClass, controlKeyword, field, extensionMethod…), которых тема Fresh не
знает и рисует обычным текстом. Прокси переименовывает их в стандартные типы
LSP в легенде (initialize / client/registerCapability); индексы и данные
токенов не меняются.

Четвёртая: декомпилированные файлы Roslyn кладёт в $TMPDIR
(/var/folders/…/MetadataAsSource/…), а Fresh раскрывает симлинк macOS и
открывает их как /private/var/folders/…. По такому пути Roslyn не узнаёт свой
файл (считает его посторонним), и переход к определению из него не работает.
Прокси возвращает в сообщениях к серверу исходный путь /var/folders/….

Пятая: в markdown подсказок (hover, signatureHelp) Roslyn ставит HTML-сущность
&nbsp; (например, перед текстом <returns>), а Fresh её не понимает. Прокси
заменяет её на символ неразрывного пробела в ответах на эти запросы.

Шестая: пока у проекта нет полной информации (загрузка, перезагрузка после
restore), Roslyn на запрос семантической подсветки отвечает пустым списком и
сам потом refresh не присылает. Fresh применяет пустой ответ — цвета в видимой
области слетают до грамматических — и считает область обновлённой, так что не
переспрашивает до правки или прокрутки. Прокси придерживает пустой ответ и
каждые полторы секунды повторяет запрос к Roslyn, пока не придут токены (до
минуты); Fresh получает один ответ, просто позже. Отмену такого запроса прокси
отрабатывает сам.

Седьмая: в конце декомпилированного файла Roslyn оставляет журнал декомпиляции
(блок `#if false // …` … `#endif`), а добавленные им using пишет с CRLF среди
строк с LF — Fresh показывает лишние \r как <0D>. Прокси вырезает журнал и
выравнивает концы строк в файле на диске, когда файл появляется в ответе
сервера, — до того, как Fresh его откроет. Журнал стоит в самом конце, а концы
строк в LSP-позиции не входят, так что позиции кода не сдвигаются.

Запуск: roslyn-proxy.py -- roslyn-language-server --stdio ...
"""

import json
import os
import re
import subprocess
import sys
import threading
from urllib.parse import unquote

docs = {}

REFRESH_TRIGGERS = {"workspace/projectInitializationComplete", "workspace/semanticTokens/refresh"}
REFRESH_DELAY = 1.5  # секунды тишины после последнего изменения решения
PROXY_ID_PREFIX = "roslyn-proxy-"

# /private/var — реальный путь симлинка /var на macOS; Roslyn знает свои
# временные файлы (декомпиляция) только по пути через /var.
CLIENT_URI_REWRITES = (
    (b"file:///private/var/folders/", b"file:///var/folders/"),
)

# Нестандартные типы токенов Roslyn -> стандартные типы LSP.
TOKEN_TYPE_MAP = {
    "recordClass": "class",
    "recordStruct": "struct",
    "delegate": "type",
    "functionPointer": "type",
    "pointer": "type",
    "module": "namespace",
    # Fresh красит parameter/variable/property/enumMember/event одним цветом
    # syntax.variable; чтобы поля, свойства, события и члены перечислений были
    # голубыми, как в Rider, отдаём их как number (цвет syntax.constant,
    # задаётся в теме hc-diagnostics).
    "field": "number",
    "property": "number",
    "event": "number",
    "enumMember": "number",
    "constant": "number",
    "label": "variable",
    "extensionMethod": "method",
    "controlKeyword": "keyword",
    "operatorOverloaded": "operator",
    "stringVerbatim": "string",
    "stringEscapeCharacter": "string",
    "excludedCode": "comment",
    "preprocessorText": "macro",
}
TOKEN_TYPE_PREFIX_MAP = (
    ("xmlDocComment", "comment"),
    ("regex", "regexp"),
    ("json", "string"),
)


def map_token_type(name):
    if name in TOKEN_TYPE_MAP:
        return TOKEN_TYPE_MAP[name]
    for prefix, target in TOKEN_TYPE_PREFIX_MAP:
        if name.startswith(prefix):
            return target
    return name


def map_legend(legend):
    if isinstance(legend, dict) and isinstance(legend.get("tokenTypes"), list):
        legend["tokenTypes"] = [map_token_type(t) for t in legend["tokenTypes"]]
        return True
    return False


def fix_server_message(msg):
    """Правит легенду семантических токенов; True, если сообщение изменено."""
    if msg.get("method") == "client/registerCapability":
        changed = False
        for reg in (msg.get("params") or {}).get("registrations") or []:
            if reg.get("method") == "textDocument/semanticTokens":
                changed |= map_legend((reg.get("registerOptions") or {}).get("legend"))
        return changed
    caps = (msg.get("result") or {}).get("capabilities") if isinstance(msg.get("result"), dict) else None
    if isinstance(caps, dict) and isinstance(caps.get("semanticTokensProvider"), dict):
        return map_legend(caps["semanticTokensProvider"].get("legend"))
    return False


def replace_in_strings(value, old, new):
    if isinstance(value, str):
        return value.replace(old, new)
    if isinstance(value, list):
        return [replace_in_strings(v, old, new) for v in value]
    if isinstance(value, dict):
        return {k: replace_in_strings(v, old, new) for k, v in value.items()}
    return value


NESTED_ACTION_COMMAND = "roslyn.client.nestedCodeAction"
FIX_ALL_COMMAND = "roslyn.client.fixAllCodeAction"


def flatten_code_actions(actions):
    """Разворачивает вложенные меню Roslyn в обычные пункты и убирает «Исправить все».

    Обе формы — клиентские команды VS Code (подменю и выбор области), Fresh их
    не знает, и выбор такого пункта ничего не делает. Вложенные пункты несут
    data для codeAction/resolve, их Fresh применяет как обычные исправления.
    """
    out = []
    for action in actions or []:
        command = (action.get("command") or {}).get("command") if isinstance(action, dict) else None
        if command == NESTED_ACTION_COMMAND:
            args = (action["command"].get("arguments") or [{}])[0] or {}
            out.extend(flatten_code_actions(args.get("NestedCodeActions")))
        elif command == FIX_ALL_COMMAND:
            continue
        else:
            path = ((action.get("data") or {}).get("CodeActionPath") or []) if isinstance(action, dict) else []
            if len(path) > 2:
                action["title"] = " → ".join(path[1:])
            out.append(action)
    return out


DOC_METHODS = {"textDocument/hover", "textDocument/signatureHelp"}
doc_request_ids = set()  # id запросов hover/signatureHelp, ждущих ответа
code_action_request_ids = set()  # id запросов textDocument/codeAction

SEMANTIC_METHODS = {"textDocument/semanticTokens/range", "textDocument/semanticTokens/full"}
SEMANTIC_RETRY_DELAY = 1.5  # секунды между повторами пустого запроса подсветки
SEMANTIC_MAX_RETRIES = 40  # около минуты, дальше отдаём пустой ответ как есть
REQUEST_CANCELLED = -32800
held_semantic = {}  # id запроса клиента (json) -> {"request": запрос, "retries": число повторов}
semantic_retry_ids = {}  # id нашего повтора -> id запроса клиента (json)
held_lock = threading.Lock()


def is_empty_semantic_result(msg):
    if "error" in msg:
        return False
    result = msg.get("result")
    return result is None or not (result.get("data") if isinstance(result, dict) else None)


DECOMPILED_DIR = "/MetadataAsSource/"
DECOMPILATION_LOG = re.compile(rb"(\r?\n)(?:[ \t]*\r?\n)*[ \t]*#if false //[^\r\n]*\r?\n.*?#endif\s*\Z", re.S)


def file_uris(value):
    if isinstance(value, str):
        if value.startswith("file://"):
            yield value
    elif isinstance(value, list):
        for v in value:
            yield from file_uris(v)
    elif isinstance(value, dict):
        for v in value.values():
            yield from file_uris(v)


def clean_decompiled_text(data):
    """Убирает журнал декомпиляции и приводит концы строк к преобладающим."""
    data = DECOMPILATION_LOG.sub(lambda m: m.group(1), data)
    crlf = data.count(b"\r\n")
    if crlf * 2 < data.count(b"\n"):
        return data.replace(b"\r\n", b"\n")
    return re.sub(rb"(?<!\r)\n", b"\r\n", data)


def clean_decompiled_file(uri):
    path = unquote(uri[len("file://"):])
    try:
        with open(path, "rb") as f:
            data = f.read()
        stripped = clean_decompiled_text(data)
        if stripped != data:
            mode = os.stat(path).st_mode  # Roslyn создаёт файл только для чтения
            os.chmod(path, mode | 0o200)
            try:
                with open(path, "wb") as f:
                    f.write(stripped)
            finally:
                os.chmod(path, mode)
    except OSError as e:
        sys.stderr.write("roslyn-proxy: %s\n" % e)


out_lock = threading.Lock()
refresh_timer = None
refresh_seq = 0
server_lock = threading.Lock()
server_stdin = None


def read_message(stream):
    headers = {}
    while True:
        line = stream.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        key, _, value = line.decode("ascii", "replace").partition(":")
        headers[key.strip().lower()] = value.strip()
    return stream.read(int(headers.get("content-length", 0)))


def write_message(stream, body):
    stream.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
    stream.flush()


def utf16_len(text):
    return sum(2 if ord(c) > 0xFFFF else 1 for c in text)


def to_index(text, pos):
    """LSP-позиция (строка, UTF-16 символ) -> индекс в строке Python."""
    idx = 0
    for _ in range(pos["line"]):
        nl = text.find("\n", idx)
        if nl < 0:
            return len(text)
        idx = nl + 1
    units = 0
    while idx < len(text) and text[idx] != "\n" and units < pos["character"]:
        units += 2 if ord(text[idx]) > 0xFFFF else 1
        idx += 1
    return idx


def end_position(text):
    return {"line": text.count("\n"), "character": utf16_len(text[text.rfind("\n") + 1:])}


def fix(msg):
    """Обновляет копии документов; возвращает True, если сообщение изменено."""
    method = msg.get("method")
    params = msg.get("params") or {}
    if method == "textDocument/didOpen":
        doc = params["textDocument"]
        docs[doc["uri"]] = doc.get("text", "")
    elif method == "textDocument/didClose":
        docs.pop(params["textDocument"]["uri"], None)
    elif method == "textDocument/didChange":
        uri = params["textDocument"]["uri"]
        text = docs.get(uri)
        changed = False
        for change in params.get("contentChanges") or []:
            if change.get("range") is None:
                if text is not None:
                    change["range"] = {"start": {"line": 0, "character": 0}, "end": end_position(text)}
                    change.pop("rangeLength", None)
                    changed = True
                text = change.get("text", "")
            elif text is not None:
                start = to_index(text, change["range"]["start"])
                end = to_index(text, change["range"]["end"])
                text = text[:start] + change.get("text", "") + text[end:]
        if text is not None:
            docs[uri] = text
        return changed
    return False


def send_to_client(body):
    with out_lock:
        write_message(sys.stdout.buffer, body)


def request_diagnostic_refresh():
    global refresh_seq
    refresh_seq += 1
    send_to_client(json.dumps({
        "jsonrpc": "2.0",
        "id": "%s%d" % (PROXY_ID_PREFIX, refresh_seq),
        "method": "workspace/diagnostic/refresh",
    }).encode("utf-8"))


def schedule_diagnostic_refresh():
    global refresh_timer
    if refresh_timer is not None:
        refresh_timer.cancel()
    refresh_timer = threading.Timer(REFRESH_DELAY, request_diagnostic_refresh)
    refresh_timer.daemon = True
    refresh_timer.start()


def send_to_server(body):
    with server_lock:
        write_message(server_stdin, body)


def resend_semantic(key):
    global refresh_seq
    with held_lock:
        held = held_semantic.get(key)
        if held is None:
            return  # клиент успел отменить запрос
        refresh_seq += 1
        retry_id = "%sst-%d" % (PROXY_ID_PREFIX, refresh_seq)
        semantic_retry_ids[retry_id] = key
        request = dict(held["request"], id=retry_id)
    try:
        send_to_server(json.dumps(request, ensure_ascii=False).encode("utf-8"))
    except (BrokenPipeError, ValueError):
        pass


def handle_semantic_response(msg):
    """Ответ на запрос подсветки (свой или наш повтор) -> что отдать клиенту; None — придержать."""
    msg_id = msg.get("id")
    with held_lock:
        key = semantic_retry_ids.pop(msg_id, None) if isinstance(msg_id, str) else None
        if key is None:
            key = json.dumps(msg_id)
        held = held_semantic.get(key)
        if held is None:
            return None  # повтор отменённого запроса
        if is_empty_semantic_result(msg) and held["retries"] < SEMANTIC_MAX_RETRIES:
            held["retries"] += 1
            timer = threading.Timer(SEMANTIC_RETRY_DELAY, resend_semantic, (key,))
            timer.daemon = True
            timer.start()
            return None
        del held_semantic[key]
    msg["id"] = held["request"]["id"]
    return msg


def cancel_held_semantic(msg):
    """$/cancelRequest для придержанного запроса: отвечаем клиенту сами; True — серверу не пересылать."""
    key = json.dumps((msg.get("params") or {}).get("id"))
    with held_lock:
        held = held_semantic.get(key)
        if held is None or held["retries"] == 0:
            return False  # запрос ещё у сервера — пусть отменяет он
        del held_semantic[key]
    send_to_client(json.dumps({
        "jsonrpc": "2.0",
        "id": held["request"]["id"],
        "error": {"code": REQUEST_CANCELLED, "message": "roslyn-proxy: запрос отменён"},
    }).encode("utf-8"))
    return True


def is_proxy_response(msg):
    msg_id = msg.get("id")
    return "method" not in msg and isinstance(msg_id, str) and msg_id.startswith(PROXY_ID_PREFIX)


def main():
    args = sys.argv[1:]
    if args and args[0] == "--":
        args = args[1:]
    global server_stdin
    child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    server_stdin = child.stdin

    def pump_server_output():
        while True:
            body = read_message(child.stdout)
            if body is None:
                break
            msg = None
            try:
                msg = json.loads(body)
                if fix_server_message(msg):
                    body = json.dumps(msg, ensure_ascii=False).encode("utf-8")
                if "method" not in msg and json.dumps(msg.get("id")) in code_action_request_ids:
                    code_action_request_ids.discard(json.dumps(msg.get("id")))
                    if isinstance(msg.get("result"), list):
                        msg["result"] = flatten_code_actions(msg["result"])
                        body = json.dumps(msg, ensure_ascii=False).encode("utf-8")
                if "method" not in msg and json.dumps(msg.get("id")) in doc_request_ids:
                    doc_request_ids.discard(json.dumps(msg.get("id")))
                    # В сыром JSON сервер пишет & как &, поэтому правим разобранное.
                    if "&nbsp;" in json.dumps(msg.get("result"), ensure_ascii=False):
                        msg["result"] = replace_in_strings(msg.get("result"), "&nbsp;", " ")
                        body = json.dumps(msg, ensure_ascii=False).encode("utf-8")
                if "method" not in msg and (msg.get("id") in semantic_retry_ids or json.dumps(msg.get("id")) in held_semantic):
                    msg = handle_semantic_response(msg)
                    if msg is None:
                        continue
                    body = json.dumps(msg, ensure_ascii=False).encode("utf-8")
                if "method" not in msg and DECOMPILED_DIR.encode() in body:
                    for uri in set(file_uris(msg.get("result"))):
                        if DECOMPILED_DIR in uri and uri.endswith(".cs"):
                            clean_decompiled_file(uri)
            except Exception as e:
                sys.stderr.write("roslyn-proxy: %s\n" % e)
            send_to_client(body)
            if isinstance(msg, dict) and msg.get("method") in REFRESH_TRIGGERS:
                schedule_diagnostic_refresh()
        os._exit(child.wait())

    threading.Thread(target=pump_server_output, daemon=True).start()

    stdin = sys.stdin.buffer
    while True:
        body = read_message(stdin)
        if body is None:
            break
        for old, new in CLIENT_URI_REWRITES:
            if old in body:
                body = body.replace(old, new)
        try:
            msg = json.loads(body)
            if is_proxy_response(msg):
                continue  # ответ Fresh на наш refresh — серверу он не нужен
            if msg.get("method") in DOC_METHODS and "id" in msg:
                doc_request_ids.add(json.dumps(msg["id"]))
            if msg.get("method") == "textDocument/codeAction" and "id" in msg:
                code_action_request_ids.add(json.dumps(msg["id"]))
            if msg.get("method") in SEMANTIC_METHODS and "id" in msg:
                with held_lock:
                    held_semantic[json.dumps(msg["id"])] = {"request": msg, "retries": 0}
            if msg.get("method") == "$/cancelRequest" and cancel_held_semantic(msg):
                continue
            if fix(msg):
                body = json.dumps(msg, ensure_ascii=False).encode("utf-8")
        except Exception as e:  # прокси не должен ронять сессию
            sys.stderr.write("roslyn-proxy: %s\n" % e)
        try:
            send_to_server(body)
        except BrokenPipeError:
            break
    try:
        child.stdin.close()
    except Exception:
        pass
    sys.exit(child.wait())


if __name__ == "__main__":
    main()
