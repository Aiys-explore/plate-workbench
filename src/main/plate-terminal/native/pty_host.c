/* plate-terminal ConPTY host addon (N-API 8, lazy host binding, no node.lib).
 * N-API symbols resolve from the host process at registration (m45-terminal
 * pattern), ConPTY symbols from kernel32 at registration, so the addon works
 * in node.exe and renamed Electron hosts alike. All handles belong to this
 * process; closing it ends every slot. ConPTY requires Windows 10 1809+. */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
#include <stdbool.h>
#include <string.h>
#include <stdlib.h>

#define NAPI_EXTERN
#include "node_api.h"

#ifndef PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
#define PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE 0x00020016
#endif

typedef VOID *HPCON;
typedef HRESULT (WINAPI *PFN_CreatePseudoConsole)(COORD size, HANDLE hInput,
  HANDLE hOutput, DWORD dwFlags, HPCON *phPty);
typedef HRESULT (WINAPI *PFN_ResizePseudoConsole)(HPCON hPty, COORD size);
typedef VOID (WINAPI *PFN_ClosePseudoConsole)(HPCON hPty);

static PFN_CreatePseudoConsole pCreatePseudoConsole;
static PFN_ResizePseudoConsole pResizePseudoConsole;
static PFN_ClosePseudoConsole pClosePseudoConsole;

#define IMPORT(fn) static __typeof__(&fn) host_##fn;
IMPORT(napi_create_object)
IMPORT(napi_create_string_utf8)
IMPORT(napi_create_uint32)
IMPORT(napi_create_int64)
IMPORT(napi_get_cb_info)
IMPORT(napi_get_named_property)
IMPORT(napi_get_value_string_utf8)
IMPORT(napi_get_value_uint32)
IMPORT(napi_get_value_int64)
IMPORT(napi_get_element)
IMPORT(napi_get_array_length)
IMPORT(napi_get_typedarray_info)
IMPORT(napi_create_function)
IMPORT(napi_typeof)
IMPORT(napi_create_buffer_copy)
IMPORT(napi_set_named_property)
IMPORT(napi_throw_error)
#undef IMPORT

#define CALL(fn, ...) (host_##fn(__VA_ARGS__) == napi_ok)
#define DO(expr) do { if (!(expr)) goto failed; } while (0)

/* ---------------------------------------------------------------- slots */

#define PTY_MAX_SLOTS 64
#define PTY_BUFFER_CAP (1024u * 1024u)

typedef struct SlotReal {
  int used;
  unsigned int id;
  HANDLE process;
  HPCON conpty;
  HANDLE pipeIn;    /* we write here */
  HANDLE pipeOut;   /* we read here */
  HANDLE thread;
  CRITICAL_SECTION cs;
  unsigned char *buffer;
  size_t head;
  size_t tail;
  size_t count;
  unsigned long long dropped;
  unsigned long long produced;
  int exited;
  DWORD exitCode;
  DWORD pid;
} SlotReal;

static SlotReal slots[PTY_MAX_SLOTS];
static unsigned int nextId = 1;

static SlotReal *slotById(unsigned int id) {
  for (int i = 0; i < PTY_MAX_SLOTS; ++i)
    if (slots[i].used && slots[i].id == id) return &slots[i];
  return NULL;
}

static void bufferPush(SlotReal *s, const unsigned char *data, size_t n) {
  const size_t added = n;
  s->produced += n;
  if (n > PTY_BUFFER_CAP) {
    s->dropped += n - PTY_BUFFER_CAP;
    data += n - PTY_BUFFER_CAP;
    n = PTY_BUFFER_CAP;
  }
  if (s->count + n > PTY_BUFFER_CAP) {
    size_t drop = s->count + n - PTY_BUFFER_CAP;
    s->head = (s->head + drop) % PTY_BUFFER_CAP;
    s->count -= drop;
    s->dropped += drop;
  }
  while (n > 0) {
    size_t room = PTY_BUFFER_CAP - s->tail;
    if (room > n) room = n;
    memcpy(s->buffer + s->tail, data, room);
    s->tail = (s->tail + room) % PTY_BUFFER_CAP;
    data += room;
    n -= room;
  }
  s->count += added;
}

static size_t bufferTake(SlotReal *s, unsigned char *out, size_t cap) {
  size_t total = 0;
  while (total < cap && s->count > 0) {
    size_t avail = (s->head < s->tail)
        ? s->tail - s->head
        : (s->head > s->tail || s->count == PTY_BUFFER_CAP ? PTY_BUFFER_CAP - s->head : s->count);
    if (avail > cap - total) avail = cap - total;
    memcpy(out + total, s->buffer + s->head, avail);
    s->head = (s->head + avail) % PTY_BUFFER_CAP;
    s->count -= avail;
    total += avail;
  }
  return total;
}

static DWORD WINAPI readerThread(LPVOID arg) {
  SlotReal *s = (SlotReal *)arg;
  unsigned char *chunk = (unsigned char *)malloc(64u * 1024u);
  if (!chunk) {
    EnterCriticalSection(&s->cs);
    s->exited = 1;
    s->exitCode = (DWORD)-1;
    LeaveCriticalSection(&s->cs);
    return 0;
  }
  for (;;) {
    DWORD available = 0;
    if (!PeekNamedPipe(s->pipeOut, NULL, 0, NULL, &available, NULL)) break;
    if (available > 0) {
      DWORD got = 0;
      DWORD want = available < 64u * 1024u ? available : 64u * 1024u;
      if (!ReadFile(s->pipeOut, chunk, want, &got, NULL) || got == 0) break;
      EnterCriticalSection(&s->cs);
      bufferPush(s, chunk, got);
      LeaveCriticalSection(&s->cs);
      continue;
    }
    /* no data pending: poll the child so an exited child ends the loop even
     * though conhost keeps the pipe open on this Windows build */
    DWORD state = WaitForSingleObject(s->process, 15);
    if (state == WAIT_OBJECT_0) {
      for (;;) {
        DWORD pending = 0;
        if (!PeekNamedPipe(s->pipeOut, NULL, 0, NULL, &pending, NULL) || pending == 0) break;
        DWORD got = 0;
        DWORD want = pending < 64u * 1024u ? pending : 64u * 1024u;
        if (!ReadFile(s->pipeOut, chunk, want, &got, NULL) || got == 0) break;
        EnterCriticalSection(&s->cs);
        bufferPush(s, chunk, got);
        LeaveCriticalSection(&s->cs);
      }
      break;
    }
  }
  free(chunk);
  WaitForSingleObject(s->process, INFINITE);
  DWORD code = 0;
  GetExitCodeProcess(s->process, &code);
  EnterCriticalSection(&s->cs);
  s->exited = 1;
  s->exitCode = code;
  LeaveCriticalSection(&s->cs);
  return 0;
}

static void slotFree(SlotReal *s) {
  if (s->thread) { CloseHandle(s->thread); s->thread = NULL; }
  if (s->process) { CloseHandle(s->process); s->process = NULL; }
  if (s->pipeIn) { CloseHandle(s->pipeIn); s->pipeIn = NULL; }
  if (s->pipeOut) { CloseHandle(s->pipeOut); s->pipeOut = NULL; }
  if (s->buffer) { free(s->buffer); s->buffer = NULL; }
  DeleteCriticalSection(&s->cs);
  memset(s, 0, sizeof(*s));
}

/* ---------------------------------------------------------------- napi helpers */

static napi_value slotError(napi_env env, const char *op, DWORD win32) {
  napi_value obj, v, c;
  DO(CALL(napi_create_object, env, &obj));
  DO(CALL(napi_create_string_utf8, env, "error", 5, &v));
  DO(CALL(napi_set_named_property, env, obj, "status", v));
  DO(CALL(napi_create_string_utf8, env, op, NAPI_AUTO_LENGTH, &v));
  DO(CALL(napi_set_named_property, env, obj, "op", v));
  DO(CALL(napi_create_uint32, env, win32, &c));
  DO(CALL(napi_set_named_property, env, obj, "win32", c));
  return obj;
failed:
  return NULL;
}

static int utf16Pair(const char *u8, WCHAR *out, size_t cap) {
  int n = MultiByteToWideChar(CP_UTF8, 0, u8, -1, out, (int)cap);
  return n > 0;
}

static int buildArgvUtf16(napi_env env, napi_value jsArgv, WCHAR ***out, int *outCount) {
  *out = NULL; *outCount = 0;
  uint32_t len = 0;
  if (!CALL(napi_get_array_length, env, jsArgv, &len)) return 0;
  if (len == 0 || len > 32) return 0;
  WCHAR **vec = (WCHAR **)calloc(len + 1, sizeof(WCHAR *));
  if (!vec) return 0;
  for (uint32_t i = 0; i < len; ++i) {
    napi_value item;
    size_t n = 0;
    if (!CALL(napi_get_element, env, jsArgv, i, &item)) goto fail;
    if (!CALL(napi_get_value_string_utf8, env, item, NULL, 0, &n) || n > 8000) goto fail;
    char *u8 = (char *)malloc(n + 1);
    if (!u8) goto fail;
    if (!CALL(napi_get_value_string_utf8, env, item, u8, n + 1, &n)) { free(u8); goto fail; }
    int wlen = MultiByteToWideChar(CP_UTF8, 0, u8, -1, NULL, 0);
    if (wlen <= 0 || wlen > 2048) { free(u8); goto fail; }
    WCHAR *w = (WCHAR *)malloc((size_t)wlen * sizeof(WCHAR));
    if (!w || MultiByteToWideChar(CP_UTF8, 0, u8, -1, w, wlen) <= 0) { free(u8); free(w); goto fail; }
    free(u8);
    vec[i] = w;
  }
  *out = vec; *outCount = (int)len;
  return 1;
fail:
  for (uint32_t i = 0; i < len; ++i) free(vec[i]);
  free(vec);
  return 0;
}

static void freeArgvUtf16(WCHAR **vec) {
  if (!vec) return;
  for (int i = 0; vec[i]; ++i) free(vec[i]);
  free(vec);
}

/* Clone the sorted Windows Unicode environment, changing only the dsh child. */
static WCHAR *runAsNodeEnvironment(void) {
  static const WCHAR key[] = L"ELECTRON_RUN_AS_NODE=";
  static const WCHAR entry[] = L"ELECTRON_RUN_AS_NODE=1";
  const size_t keyLen = ARRAYSIZE(key) - 1;
  WCHAR *env = GetEnvironmentStringsW();
  if (!env) return NULL;
  const WCHAR *end = env;
  while (*end) end += wcslen(end) + 1;
  WCHAR *block = (WCHAR *)malloc(((size_t)(end - env) + ARRAYSIZE(entry) + 2) * sizeof(WCHAR));
  if (!block) { FreeEnvironmentStringsW(env); return NULL; }
  WCHAR *out = block;
  int inserted = 0;
  for (const WCHAR *p = env; *p; p += wcslen(p) + 1) {
    const int order = CompareStringOrdinal(p, (int)(wcslen(p) < keyLen ? wcslen(p) : keyLen), key, (int)keyLen, TRUE);
    if (!inserted && order != CSTR_LESS_THAN) {
      memcpy(out, entry, sizeof(entry));
      out += ARRAYSIZE(entry);
      inserted = 1;
    }
    if (order == CSTR_EQUAL) continue;
    const size_t len = wcslen(p) + 1;
    memcpy(out, p, len * sizeof(WCHAR));
    out += len;
  }
  if (!inserted) { memcpy(out, entry, sizeof(entry)); out += ARRAYSIZE(entry); }
  *out = 0;
  FreeEnvironmentStringsW(env);
  return block;
}

/* ---------------------------------------------------------------- API: open */

static napi_value ApiOpen(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value av[1];
  DO(CALL(napi_get_cb_info, env, info, &argc, av, NULL, NULL));
  if (argc < 1) { host_napi_throw_error(env, NULL, "open requires options"); return NULL; }

  napi_value jsArgv, jsCwd, jsCols, jsRows, jsRunAsNode;
  uint32_t runAsNode = 0;
  if (CALL(napi_get_named_property, env, av[0], "runAsNode", &jsRunAsNode))
    CALL(napi_get_value_uint32, env, jsRunAsNode, &runAsNode);
  DO(CALL(napi_get_named_property, env, av[0], "argv", &jsArgv));
  DO(CALL(napi_get_named_property, env, av[0], "cwd", &jsCwd));
  DO(CALL(napi_get_named_property, env, av[0], "cols", &jsCols));
  DO(CALL(napi_get_named_property, env, av[0], "rows", &jsRows));

  WCHAR **argv = NULL;
  int argcW = 0;
  if (!buildArgvUtf16(env, jsArgv, &argv, &argcW)) {
    host_napi_throw_error(env, NULL, "argv must be 1..32 utf8 strings");
    return NULL;
  }
  WCHAR cwd[1024];
  int haveCwd = 0;
  {
    size_t n = 0;
    char *u8 = NULL;
    if (CALL(napi_get_value_string_utf8, env, jsCwd, NULL, 0, &n) && n > 0 && n <= 1020) {
      u8 = (char *)malloc(n + 1);
      if (u8 && CALL(napi_get_value_string_utf8, env, jsCwd, u8, n + 1, &n) && utf16Pair(u8, cwd, 1024))
        haveCwd = 1;
      free(u8);
    }
    if (!haveCwd) {
      size_t n2 = 0;
      if (!CALL(napi_get_value_string_utf8, env, jsCwd, NULL, 0, &n2) || n2 > 1020) {
        freeArgvUtf16(argv);
        host_napi_throw_error(env, NULL, "cwd must be a short utf8 string");
        return NULL;
      }
    }
    u8 = (char *)malloc(n + 1);
    if (!u8 || !CALL(napi_get_value_string_utf8, env, jsCwd, u8, n + 1, &n) || !utf16Pair(u8, cwd, 1024)) {
      free(u8);
      freeArgvUtf16(argv);
      host_napi_throw_error(env, NULL, "cwd conversion failed");
      return NULL;
    }
    free(u8);
  }
  uint32_t cols = 80, rows = 25;
  CALL(napi_get_value_uint32, env, jsCols, &cols);
  CALL(napi_get_value_uint32, env, jsRows, &rows);
  if (cols == 0 || cols > 500) cols = 80;
  if (rows == 0 || rows > 200) rows = 25;

  SlotReal *s = NULL;
  for (int i = 0; i < PTY_MAX_SLOTS; ++i) if (!slots[i].used) { s = &slots[i]; break; }
  if (!s) { freeArgvUtf16(argv); host_napi_throw_error(env, NULL, "slot table full"); return NULL; }
  memset(s, 0, sizeof(*s));
  InitializeCriticalSection(&s->cs);
  s->buffer = (unsigned char *)malloc(PTY_BUFFER_CAP);
  if (!s->buffer) {
    DeleteCriticalSection(&s->cs);
    memset(s, 0, sizeof(*s));
    freeArgvUtf16(argv);
    host_napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }

  HANDLE inRead = NULL, outWrite = NULL;
  STARTUPINFOEXW si;
  PROCESS_INFORMATION pi;
  SIZE_T attrSize = 0;
  DWORD win32Error = 0;
  int attrReady = 0;
  int ptyOpen = 0;
  int procOpen = 0;

  if (!CreatePipe(&s->pipeOut, &outWrite, NULL, 0) ||
      !CreatePipe(&inRead, &s->pipeIn, NULL, 0)) { win32Error = GetLastError(); goto failure; }
  if (pCreatePseudoConsole((COORD){(SHORT)cols, (SHORT)rows}, inRead, outWrite, 0, &s->conpty) != S_OK) {
    win32Error = 0xFFFFFFFEu;
    goto failure;
  }
  ptyOpen = 1;

  ZeroMemory(&si, sizeof(si));
  si.StartupInfo.cb = sizeof(si);
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  InitializeProcThreadAttributeList(NULL, 1, 0, &attrSize);
  si.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attrSize);
  if (!si.lpAttributeList) { win32Error = ERROR_NOT_ENOUGH_MEMORY; goto failure; }
  if (!InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &attrSize) ||
      !UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
        s->conpty, sizeof(s->conpty), NULL, NULL)) {
    win32Error = GetLastError();
    goto failure;
  }
  attrReady = 1;

  ZeroMemory(&pi, sizeof(pi));
  {
    WCHAR cmdline[8192];
    size_t used = 0;
    cmdline[0] = 0;
    for (int i = 0; i < argcW; ++i) {
      size_t len = wcslen(argv[i]);
      if (used + len + 4 >= 8192) { win32Error = ERROR_INVALID_PARAMETER; goto failure; }
      if (i > 0) cmdline[used++] = L' ';
      cmdline[used++] = L'"';
      for (size_t k = 0; k < len; ++k) cmdline[used++] = argv[i][k];
      cmdline[used++] = L'"';
      cmdline[used] = 0;
    }
    WCHAR *childEnv = runAsNode ? runAsNodeEnvironment() : NULL;
    if (runAsNode && !childEnv) { win32Error = ERROR_NOT_ENOUGH_MEMORY; goto failure; }
    const BOOL created = CreateProcessW(argv[0], cmdline, NULL, NULL, FALSE,
          EXTENDED_STARTUPINFO_PRESENT | (childEnv ? CREATE_UNICODE_ENVIRONMENT : 0),
          childEnv, haveCwd ? cwd : NULL, &si.StartupInfo, &pi);
    if (!created) win32Error = GetLastError();
    free(childEnv);
    if (!created) goto failure;
  }
  procOpen = 1;
  DeleteProcThreadAttributeList(si.lpAttributeList);
  HeapFree(GetProcessHeap(), 0, si.lpAttributeList);
  attrReady = 0;
  CloseHandle(pi.hThread);
  s->process = pi.hProcess;
  s->pid = pi.dwProcessId;
  s->id = nextId++;
  s->used = 1;
  freeArgvUtf16(argv);
  argv = NULL;

  s->thread = CreateThread(NULL, 0, readerThread, s, 0, NULL);
  if (!s->thread) { win32Error = GetLastError(); goto failure; }
  CloseHandle(inRead); inRead = NULL;
  CloseHandle(outWrite); outWrite = NULL;

  {
    napi_value obj, v;
    DO(CALL(napi_create_object, env, &obj));
    DO(CALL(napi_create_string_utf8, env, "ok", 2, &v));
    DO(CALL(napi_set_named_property, env, obj, "status", v));
    DO(CALL(napi_create_uint32, env, s->id, &v));
    DO(CALL(napi_set_named_property, env, obj, "id", v));
    DO(CALL(napi_create_uint32, env, s->pid, &v));
    DO(CALL(napi_set_named_property, env, obj, "pid", v));
    return obj;
  }

failure:
  if (argv) freeArgvUtf16(argv);
  if (attrReady && si.lpAttributeList) DeleteProcThreadAttributeList(si.lpAttributeList);
  if (si.lpAttributeList) HeapFree(GetProcessHeap(), 0, si.lpAttributeList);
  if (procOpen) TerminateProcess(s->process, (UINT)0x000103);
  if (s->thread) { WaitForSingleObject(s->thread, 5000); CloseHandle(s->thread); s->thread = NULL; }
  if (ptyOpen) { pClosePseudoConsole(s->conpty); s->conpty = NULL; }
  if (s->process) { CloseHandle(s->process); s->process = NULL; }
  if (s->pipeIn) { CloseHandle(s->pipeIn); s->pipeIn = NULL; }
  if (s->pipeOut) { CloseHandle(s->pipeOut); s->pipeOut = NULL; }
  if (inRead) CloseHandle(inRead);
  if (outWrite) CloseHandle(outWrite);
  if (s->buffer) { free(s->buffer); s->buffer = NULL; }
  DeleteCriticalSection(&s->cs);
  memset(s, 0, sizeof(*s));
  return slotError(env, "open", win32Error);
failed:
  return NULL;
}

/* ---------------------------------------------------------------- API: read */

static napi_value ApiRead(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value av[2];
  DO(CALL(napi_get_cb_info, env, info, &argc, av, NULL, NULL));
  if (argc < 2) { host_napi_throw_error(env, NULL, "read requires (id, maxBytes)"); return NULL; }
  uint32_t id = 0;
  int64_t maxBytes = 0;
  CALL(napi_get_value_uint32, env, av[0], &id);
  CALL(napi_get_value_int64, env, av[1], &maxBytes);
  SlotReal *s = slotById(id);
  if (!s) return slotError(env, "unknown-slot", 0);
  if (maxBytes <= 0 || maxBytes > (int64_t)PTY_BUFFER_CAP) maxBytes = PTY_BUFFER_CAP;

  unsigned char *out = (unsigned char *)malloc((size_t)maxBytes);
  if (!out) { host_napi_throw_error(env, NULL, "out of memory"); return NULL; }
  EnterCriticalSection(&s->cs);
  size_t got = bufferTake(s, out, (size_t)maxBytes);
  unsigned long long dropped = s->dropped;
  unsigned long long produced = s->produced;
  int exited = s->exited;
  DWORD code = s->exitCode;
  DWORD pid = s->pid;
  LeaveCriticalSection(&s->cs);

  napi_value obj, v;
  DO(CALL(napi_create_object, env, &obj));
  DO(CALL(napi_create_string_utf8, env, "ok", 2, &v));
  DO(CALL(napi_set_named_property, env, obj, "status", v));
  {
    void *copy = NULL;
    DO(CALL(napi_create_buffer_copy, env, got, out, &copy, &v));
  }
  DO(CALL(napi_set_named_property, env, obj, "data", v));
  DO(CALL(napi_create_int64, env, (int64_t)dropped, &v));
  DO(CALL(napi_set_named_property, env, obj, "dropped", v));
  DO(CALL(napi_create_int64, env, (int64_t)produced, &v));
  DO(CALL(napi_set_named_property, env, obj, "produced", v));
  DO(CALL(napi_create_uint32, env, exited ? 1u : 0u, &v));
  DO(CALL(napi_set_named_property, env, obj, "exited", v));
  DO(CALL(napi_create_uint32, env, code, &v));
  DO(CALL(napi_set_named_property, env, obj, "exitCode", v));
  DO(CALL(napi_create_uint32, env, pid, &v));
  DO(CALL(napi_set_named_property, env, obj, "pid", v));
  free(out);
  return obj;
failed:
  return NULL;
}

/* ---------------------------------------------------------------- API: write / sigint */

static napi_value writeResult(napi_env env, DWORD written) {
  napi_value obj, v;
  DO(CALL(napi_create_object, env, &obj));
  DO(CALL(napi_create_string_utf8, env, "ok", 2, &v));
  DO(CALL(napi_set_named_property, env, obj, "status", v));
  DO(CALL(napi_create_uint32, env, written, &v));
  DO(CALL(napi_set_named_property, env, obj, "written", v));
  return obj;
failed:
  return NULL;
}

static napi_value writeBytes(napi_env env, unsigned int id, const unsigned char *data, size_t n) {
  SlotReal *s = slotById(id);
  if (!s) return slotError(env, "unknown-slot", 0);
  DWORD written = 0;
  if (n > 0xFFFFFFFFu) n = 0xFFFFFFFFu;
  if (!WriteFile(s->pipeIn, data, (DWORD)n, &written, NULL))
    return slotError(env, "write", GetLastError());
  return writeResult(env, written);
}

static napi_value ApiWrite(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value av[2];
  DO(CALL(napi_get_cb_info, env, info, &argc, av, NULL, NULL));
  if (argc < 2) { host_napi_throw_error(env, NULL, "write requires (id, data)"); return NULL; }
  uint32_t id = 0;
  napi_valuetype kind = napi_undefined;
  CALL(napi_get_value_uint32, env, av[0], &id);
  CALL(napi_typeof, env, av[1], &kind);
  if (kind == napi_string) {
    size_t n = 0;
    if (!CALL(napi_get_value_string_utf8, env, av[1], NULL, 0, &n)) {
      host_napi_throw_error(env, NULL, "string convert failed");
      return NULL;
    }
    char *u8 = (char *)malloc(n + 1);
    if (!u8) { host_napi_throw_error(env, NULL, "out of memory"); return NULL; }
    CALL(napi_get_value_string_utf8, env, av[1], u8, n + 1, &n);
    napi_value r = writeBytes(env, id, (const unsigned char *)u8, n);
    free(u8);
    return r;
  }
  if (kind == napi_object) {
    void *data = NULL;
    size_t n = 0, off = 0;
    napi_typedarray_type t = napi_int8_array;
    napi_value buf;
    if (!CALL(napi_get_typedarray_info, env, av[1], &t, &n, &data, &buf, &off) || t != napi_uint8_array) {
      host_napi_throw_error(env, NULL, "expected Uint8Array");
      return NULL;
    }
    return writeBytes(env, id, (const unsigned char *)data, n);
  }
  host_napi_throw_error(env, NULL, "data must be a string or Uint8Array");
  return NULL;
failed:
  return NULL;
}

static napi_value ApiSigint(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value av[1];
  DO(CALL(napi_get_cb_info, env, info, &argc, av, NULL, NULL));
  uint32_t id = 0;
  CALL(napi_get_value_uint32, env, av[0], &id);
  const unsigned char ctrlC = 0x03;
  return writeBytes(env, id, &ctrlC, 1);
failed:
  return NULL;
}

/* ---------------------------------------------------------------- API: resize / state / terminate / close */

static napi_value ApiResize(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value av[3];
  DO(CALL(napi_get_cb_info, env, info, &argc, av, NULL, NULL));
  uint32_t id = 0, cols = 0, rows = 0;
  CALL(napi_get_value_uint32, env, av[0], &id);
  CALL(napi_get_value_uint32, env, av[1], &cols);
  CALL(napi_get_value_uint32, env, av[2], &rows);
  SlotReal *s = slotById(id);
  if (!s) return slotError(env, "unknown-slot", 0);
  if (cols == 0 || rows == 0 || cols > 500 || rows > 200)
    return slotError(env, "resize", ERROR_INVALID_PARAMETER);
  if (pResizePseudoConsole(s->conpty, (COORD){(SHORT)cols, (SHORT)rows}) != S_OK)
    return slotError(env, "resize", GetLastError());
  return writeResult(env, 0);
failed:
  return NULL;
}

static napi_value ApiState(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value av[1];
  DO(CALL(napi_get_cb_info, env, info, &argc, av, NULL, NULL));
  uint32_t id = 0;
  CALL(napi_get_value_uint32, env, av[0], &id);
  SlotReal *s = slotById(id);
  if (!s) return slotError(env, "unknown-slot", 0);
  EnterCriticalSection(&s->cs);
  int exited = s->exited;
  DWORD code = s->exitCode;
  DWORD pid = s->pid;
  LeaveCriticalSection(&s->cs);
  napi_value obj, v;
  DO(CALL(napi_create_object, env, &obj));
  DO(CALL(napi_create_string_utf8, env, "ok", 2, &v));
  DO(CALL(napi_set_named_property, env, obj, "status", v));
  DO(CALL(napi_create_uint32, env, exited ? 1u : 0u, &v));
  DO(CALL(napi_set_named_property, env, obj, "exited", v));
  DO(CALL(napi_create_uint32, env, code, &v));
  DO(CALL(napi_set_named_property, env, obj, "exitCode", v));
  DO(CALL(napi_create_uint32, env, pid, &v));
  DO(CALL(napi_set_named_property, env, obj, "pid", v));
  return obj;
failed:
  return NULL;
}

static napi_value ApiTerminate(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value av[1];
  DO(CALL(napi_get_cb_info, env, info, &argc, av, NULL, NULL));
  uint32_t id = 0;
  CALL(napi_get_value_uint32, env, av[0], &id);
  SlotReal *s = slotById(id);
  if (!s) return slotError(env, "unknown-slot", 0);
  if (!TerminateProcess(s->process, (UINT)0x000103))
    return slotError(env, "terminate", GetLastError());
  return writeResult(env, 0);
failed:
  return NULL;
}

static napi_value ApiClose(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value av[1];
  DO(CALL(napi_get_cb_info, env, info, &argc, av, NULL, NULL));
  uint32_t id = 0;
  CALL(napi_get_value_uint32, env, av[0], &id);
  SlotReal *s = slotById(id);
  if (!s) return slotError(env, "unknown-slot", 0);
  pClosePseudoConsole(s->conpty);
  s->conpty = NULL;
  DWORD wait = WaitForSingleObject(s->thread, 15000);
  if (wait == WAIT_TIMEOUT) {
    TerminateProcess(s->process, (UINT)0x000103);
    WaitForSingleObject(s->thread, 5000);
  }
  EnterCriticalSection(&s->cs);
  DWORD code = s->exitCode;
  LeaveCriticalSection(&s->cs);
  slotFree(s);
  napi_value obj, v;
  DO(CALL(napi_create_object, env, &obj));
  DO(CALL(napi_create_string_utf8, env, "ok", 2, &v));
  DO(CALL(napi_set_named_property, env, obj, "status", v));
  DO(CALL(napi_create_uint32, env, code, &v));
  DO(CALL(napi_set_named_property, env, obj, "exitCode", v));
  return obj;
failed:
  return NULL;
}

/* ---------------------------------------------------------------- registration */

static napi_value bindMethod(napi_env env, napi_callback cb, napi_value exports, const char *name) {
  napi_value fn;
  if (!CALL(napi_create_function, env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn)) return NULL;
  if (!CALL(napi_set_named_property, env, exports, name, fn)) return NULL;
  return exports;
}

__declspec(dllexport) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  HMODULE host = GetModuleHandleW(NULL);
  HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
  if (!host || !k32) return NULL;
  #define LOAD(fn) host_##fn = (__typeof__(host_##fn))GetProcAddress(host, #fn); if (!host_##fn) return NULL;
  LOAD(napi_create_object)
  LOAD(napi_create_string_utf8)
  LOAD(napi_create_uint32)
  LOAD(napi_create_int64)
  LOAD(napi_get_cb_info)
  LOAD(napi_get_named_property)
  LOAD(napi_get_value_string_utf8)
  LOAD(napi_get_value_uint32)
  LOAD(napi_get_value_int64)
  LOAD(napi_get_element)
  LOAD(napi_get_array_length)
  LOAD(napi_get_typedarray_info)
  LOAD(napi_create_function)
  LOAD(napi_typeof)
  LOAD(napi_create_buffer_copy)
  LOAD(napi_set_named_property)
  LOAD(napi_throw_error)
  #undef LOAD
  #define LOADK(fn, type) p##fn = (type)GetProcAddress(k32, #fn); if (!p##fn) return NULL;
  LOADK(CreatePseudoConsole, PFN_CreatePseudoConsole)
  LOADK(ResizePseudoConsole, PFN_ResizePseudoConsole)
  LOADK(ClosePseudoConsole, PFN_ClosePseudoConsole)
  #undef LOADK
  if (!bindMethod(env, ApiOpen, exports, "open")) return NULL;
  if (!bindMethod(env, ApiRead, exports, "read")) return NULL;
  if (!bindMethod(env, ApiWrite, exports, "write")) return NULL;
  if (!bindMethod(env, ApiSigint, exports, "sigint")) return NULL;
  if (!bindMethod(env, ApiResize, exports, "resize")) return NULL;
  if (!bindMethod(env, ApiState, exports, "state")) return NULL;
  if (!bindMethod(env, ApiTerminate, exports, "terminate")) return NULL;
  if (!bindMethod(env, ApiClose, exports, "close")) return NULL;
  return exports;
}





