
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <winternl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <wchar.h>
#define NAPI_EXTERN
#include "node_api.h"

static __typeof__(&napi_call_function) host_napi_call_function;
static __typeof__(&napi_create_buffer) host_napi_create_buffer;
static __typeof__(&napi_create_function) host_napi_create_function;
static __typeof__(&napi_create_object) host_napi_create_object;
static __typeof__(&napi_get_buffer_info) host_napi_get_buffer_info;
static __typeof__(&napi_get_cb_info) host_napi_get_cb_info;
static __typeof__(&napi_is_exception_pending) host_napi_is_exception_pending;
static __typeof__(&napi_set_named_property) host_napi_set_named_property;
static __typeof__(&napi_throw_error) host_napi_throw_error;
#define napi_call_function host_napi_call_function
#define napi_create_buffer host_napi_create_buffer
#define napi_create_function host_napi_create_function
#define napi_create_object host_napi_create_object
#define napi_get_buffer_info host_napi_get_buffer_info
#define napi_get_cb_info host_napi_get_cb_info
#define napi_is_exception_pending host_napi_is_exception_pending
#define napi_set_named_property host_napi_set_named_property
#define napi_throw_error host_napi_throw_error
static __typeof__(&napi_get_value_string_utf16) host_napi_get_value_string_utf16;
static __typeof__(&napi_get_value_string_utf8) host_napi_get_value_string_utf8;
static __typeof__(&napi_get_value_int32) host_napi_get_value_int32;
static __typeof__(&napi_create_string_utf8) host_napi_create_string_utf8;
#define napi_get_value_string_utf16 host_napi_get_value_string_utf16
#define napi_get_value_string_utf8 host_napi_get_value_string_utf8
#define napi_get_value_int32 host_napi_get_value_int32
#define napi_create_string_utf8 host_napi_create_string_utf8
typedef NTSTATUS (NTAPI *OpenRelative)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
  PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef NTSTATUS (NTAPI *RenameRelative)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
typedef struct { ULONG replace; HANDLE root; ULONG length; WCHAR name[256]; } Rename;
typedef struct { HANDLE dirs[80]; unsigned count; WCHAR leaf[256]; } Path;
#define ASSERT(x) if (!(x)) goto failed
#define NAPI(x) ASSERT((x) == napi_ok)
#define CAP (16u * 1024u * 1024u)
static const DWORD badAttrs = FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_ENCRYPTED
  | FILE_ATTRIBUTE_INTEGRITY_STREAM | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;

static HANDLE relativeOpen(HANDLE dir, WCHAR *name, int folder, int mode, int *missing) {
  OpenRelative open = (OpenRelative)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile");
  size_t bytes = wcslen(name) * sizeof(WCHAR);
  UNICODE_STRING u = {(USHORT)bytes, (USHORT)bytes, name};
  OBJECT_ATTRIBUTES oa = {.Length=sizeof(oa), .RootDirectory=dir, .ObjectName=&u, .Attributes=0x40 | 0x1000};
  IO_STATUS_BLOCK io;
  HANDLE h = INVALID_HANDLE_VALUE;
  *missing = 0;
  if (!open) return h;
  ACCESS_MASK access = FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  if (folder) access |= FILE_TRAVERSE;
  else access |= FILE_READ_DATA | (mode == 1 ? DELETE : mode == 2 ? FILE_WRITE_DATA : 0);
  NTSTATUS s = open(&h, access, &oa, &io, NULL, FILE_ATTRIBUTE_NORMAL,
      folder ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_READ,
      mode == 2 ? 2 : 1, (folder ? 1 : 0x40) | 0x20 | 0x200000, NULL, 0);
  *missing = s == (NTSTATUS)0xC0000034;
  return s >= 0 ? h : INVALID_HANDLE_VALUE;
}
static int info(HANDLE h, int folder, char *key, char *stamp) {
  BY_HANDLE_FILE_INFORMATION id;
  FILE_BASIC_INFO b;
  FILE_ID_INFO full;
  if (!GetFileInformationByHandle(h, &id) || !GetFileInformationByHandleEx(h, FileBasicInfo, &b, sizeof(b)) ||
      !GetFileInformationByHandleEx(h, FileIdInfo, &full, sizeof(full)) ||
      id.dwFileAttributes & badAttrs || !!(id.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != !!folder ||
      (!folder && (id.nNumberOfLinks != 1 || id.dwFileAttributes & (FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM) ||
        id.nFileSizeHigh || id.nFileSizeLow > CAP))) return 0;
  if (!folder) {
    // Replacement must not discard opaque alternate streams or per-file encryption.
    FILE_STREAM_INFO *streams = (FILE_STREAM_INFO*)HeapAlloc(GetProcessHeap(),0,65536);
    if (!streams) return 0;
    int ok = GetFileInformationByHandleEx(h,FileStreamInfo,streams,65536) &&
      !streams->NextEntryOffset && streams->StreamNameLength == 7*sizeof(WCHAR) &&
      !wmemcmp(streams->StreamName,L"::$DATA",7);
    HeapFree(GetProcessHeap(),0,streams);
    if (!ok) return 0;
  }
  int n = snprintf(key,110,"%llx:", (unsigned long long)full.VolumeSerialNumber);
  int any = 0;
  for (int i=0; i<16; i++) {
    any |= full.FileId.Identifier[i];
    n += snprintf(key+n,110-n,"%02x",full.FileId.Identifier[i]);
  }
  if (!any || !b.CreationTime.QuadPart) return 0;
  snprintf(key+n,110-n,":%llx",(unsigned long long)b.CreationTime.QuadPart);
  snprintf(stamp,110,"%llx:%llx:%lu",(unsigned long long)b.ChangeTime.QuadPart,
      (unsigned long long)b.LastWriteTime.QuadPart,(unsigned long)id.nFileSizeLow);
  return 1;
}
static int safeName(WCHAR *s) {
  size_t n=wcslen(s);
  return n && n<256 && s[n-1]!=L'.' && s[n-1]!=L' ' && !wcspbrk(s,L":/*?\"<>|");
}
static int prefix(WCHAR *s, Path *p, char *identity, const char *forbid, const char *also) {
  if (wcslen(s) < 5 || s[1]!=L':' || s[2]!=L'\\' ||
      !((s[0]>=L'A' && s[0]<=L'Z') || (s[0]>=L'a' && s[0]<=L'z'))) return 0;
  WCHAR drive[4]={s[0],L':',L'\\',0}, fs[12];
  if (GetDriveTypeW(drive)!=DRIVE_FIXED || !GetVolumeInformationW(drive,NULL,0,NULL,NULL,NULL,fs,12) ||
      wcscmp(fs,L"NTFS")) return 0;
  HANDLE h=CreateFileW(drive,FILE_TRAVERSE|FILE_READ_ATTRIBUTES, FILE_SHARE_READ|FILE_SHARE_WRITE,
      NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,NULL);
  if (h==INVALID_HANDLE_VALUE) return 0;
  p->dirs[p->count++]=h;
  char unused[110];
  if (!info(h,1,identity,unused) || (forbid && !strcmp(forbid,identity)) || (also && !strcmp(also,identity))) return 0;
  WCHAR *part=s+3, *slash;
  while ((slash=wcschr(part,L'\\'))) {
    *slash=0;
    int missing;
    if (p->count>=80 || !safeName(part)) return 0;
    h=relativeOpen(h,part,1,0,&missing);
    if (h==INVALID_HANDLE_VALUE) return 0;
    p->dirs[p->count++]=h;
    if (!info(h,1,identity,unused) || (forbid && !strcmp(forbid,identity)) || (also && !strcmp(also,identity))) return 0;
    part=slash+1;
  }
  if (!safeName(part)) return 0;
  wcscpy(p->leaf,part);
  return 1;
}
static int getPath(napi_env e, napi_value v, WCHAR *buf) {
  size_t n;
  return napi_get_value_string_utf16(e,v,(char16_t*)buf,32768,&n)==napi_ok && n<32767 && n==wcslen(buf);
}
static int getString(napi_env e,napi_value v,char *buf) {
  size_t n;
  return napi_get_value_string_utf8(e,v,buf,112,&n)==napi_ok && n<111 && n==strlen(buf);
}
static int setString(napi_env e,napi_value obj,const char *prop,const char *s) {
  napi_value t;
  return napi_create_string_utf8(e,s,NAPI_AUTO_LENGTH,&t)==napi_ok && napi_set_named_property(e,obj,prop,t)==napi_ok;
}
// 0 capture; 1 move source with expected identity, stamp and bytes; 2 create
// an exclusive stage file, flush it; 3 capture while retaining a read lock.
static napi_value operation(napi_env e, napi_callback_info call) {
  napi_value av[10], out=0, b;
  size_t argc=10, expectedLen=0;
  void *expected=NULL, *buf=NULL;
  int32_t action;
  WCHAR a[32768], d[32768];
  char parent[110], targetParent[110], id[110], stamp[110];
  char xp[112], xd[112], xi[112], xs[112];
  Path src={0}, dst={0};
  HANDLE h=INVALID_HANDLE_VALUE, other=INVALID_HANDLE_VALUE;
  int missing=0, point=0;
  NAPI(napi_get_cb_info(e,call,&argc,av,NULL,NULL));
  ASSERT(argc>=2 && getPath(e,av[1],a));
  NAPI(napi_get_value_int32(e,av[0],&action));
  ASSERT(action>=0 && action<=5);
  point=1;
    if (action==5) ASSERT(argc==4 && getString(e,av[2],xp) && getString(e,av[3],xd));
  ASSERT(prefix(a,&src,parent,action==5?xp:NULL,action==5?xd:NULL));
  if (action==5) {
    NAPI(napi_create_object(e,&out));
    ASSERT(setString(e,out,"parent",parent));
    goto done;
  }
  if (action==4) ASSERT(argc==5 && getString(e,av[2],xp) && !strcmp(xp,parent) &&
      getString(e,av[3],xi) && getString(e,av[4],xs));
  if (action==1) {
    ASSERT(argc==8 && getPath(e,av[2],d) && getString(e,av[3],xp) &&
           getString(e,av[4],xd) && getString(e,av[5],xi) && getString(e,av[6],xs));
    NAPI(napi_get_buffer_info(e,av[7],&expected,&expectedLen));
    ASSERT(prefix(d,&dst,targetParent,NULL,NULL) && !strcmp(xp,parent) && !strcmp(xd,targetParent));
  }
  if (action==2) {
    ASSERT(argc==4 && getString(e,av[2],xp) && !strcmp(xp,parent));
    NAPI(napi_get_buffer_info(e,av[3],&expected,&expectedLen));
    ASSERT(expectedLen<=CAP);
  }
  point=2;
  h=relativeOpen(src.dirs[src.count-1],src.leaf,0,action==3?0:action==4?1:action,&missing);
  NAPI(napi_create_object(e,&out));
  ASSERT(setString(e,out,"parent",parent));
  if ((action==0 || action==3 || action==4) && missing) goto done;
  ASSERT(h!=INVALID_HANDLE_VALUE);
  if (action==2) {
    DWORD wrote;
    ASSERT(WriteFile(h,expected,(DWORD)expectedLen,&wrote,NULL) && wrote==expectedLen && FlushFileBuffers(h));
  }
  point=3;
  ASSERT(info(h,0,id,stamp));
  LARGE_INTEGER size;
  DWORD read;
  ASSERT(GetFileSizeEx(h,&size) && size.QuadPart>=0 && size.QuadPart<=CAP);
  NAPI(napi_create_buffer(e,(size_t)size.QuadPart,&buf,&b));
  LARGE_INTEGER zero={0};
  ASSERT(SetFilePointerEx(h,zero,NULL,FILE_BEGIN) && ReadFile(h,buf,(DWORD)size.QuadPart,&read,NULL) && read==size.QuadPart);
  if (action==1) {
    point=4;
    ASSERT(!strcmp(xi,id) && (!*xs || !strcmp(xs,stamp)) && read==expectedLen && !memcmp(buf,expected,read));
    other=relativeOpen(dst.dirs[dst.count-1],dst.leaf,0,0,&missing);
    ASSERT(other==INVALID_HANDLE_VALUE && missing);
    RenameRelative rename=(RenameRelative)GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtSetInformationFile");
    Rename r={0};
    r.root=dst.dirs[dst.count-1];
    r.length=(ULONG)(wcslen(dst.leaf)*sizeof(WCHAR));
    memcpy(r.name,dst.leaf,r.length);
    IO_STATUS_BLOCK io;
    point=5;
    ASSERT(rename && rename(h,&io,&r,(ULONG)(offsetof(Rename,name)+r.length), (FILE_INFORMATION_CLASS)10)>=0);
  }
  if (action==4) {
    point=6;
    ASSERT(!strcmp(xi,id) && !strcmp(xs,stamp));
    FILE_DISPOSITION_INFO disposition={.DeleteFile=TRUE};
    ASSERT(SetFileInformationByHandle(h,FileDispositionInfo,&disposition,sizeof(disposition)));
  }
  ASSERT(setString(e,out,"identity",id) && setString(e,out,"stamp",stamp));
  NAPI(napi_set_named_property(e,out,"bytes",b));
  if (action==3) {
    // Invoke a synchronous JS continuation while handles deny writes and renames.
    napi_value ignore;
    ASSERT(argc==3);
    NAPI(napi_call_function(e,out,av[2],1,&out,&ignore));
  }
  goto done;
failed:
  {
    bool pending=false; napi_is_exception_pending(e,&pending);
    char why[96]; snprintf(why,sizeof(why),"受管文件无法安全核对（%d / %lu）",point,(unsigned long)GetLastError());
    if (!pending) napi_throw_error(e,NULL,why);
    out=0;
  }
done:
  if(h!=INVALID_HANDLE_VALUE) CloseHandle(h);
  if(other!=INVALID_HANDLE_VALUE) CloseHandle(other);
  while(dst.count) CloseHandle(dst.dirs[--dst.count]);
  while(src.count) CloseHandle(src.dirs[--src.count]);
  return out;
}
NAPI_MODULE_INIT() {
  HMODULE host=GetModuleHandleW(NULL);
  if(!(host_napi_get_value_string_utf16=(void*)GetProcAddress(host,"napi_get_value_string_utf16")))return NULL;
  if(!(host_napi_get_value_string_utf8=(void*)GetProcAddress(host,"napi_get_value_string_utf8")))return NULL;
  if(!(host_napi_get_value_int32=(void*)GetProcAddress(host,"napi_get_value_int32")))return NULL;
  if(!(host_napi_create_string_utf8=(void*)GetProcAddress(host,"napi_create_string_utf8")))return NULL;
  if(!(host_napi_call_function=(void*)GetProcAddress(host,"napi_call_function")))return NULL;
  if(!(host_napi_create_buffer=(void*)GetProcAddress(host,"napi_create_buffer")))return NULL;
  if(!(host_napi_create_function=(void*)GetProcAddress(host,"napi_create_function")))return NULL;
  if(!(host_napi_create_object=(void*)GetProcAddress(host,"napi_create_object")))return NULL;
  if(!(host_napi_get_buffer_info=(void*)GetProcAddress(host,"napi_get_buffer_info")))return NULL;
  if(!(host_napi_get_cb_info=(void*)GetProcAddress(host,"napi_get_cb_info")))return NULL;
  if(!(host_napi_is_exception_pending=(void*)GetProcAddress(host,"napi_is_exception_pending")))return NULL;
  if(!(host_napi_set_named_property=(void*)GetProcAddress(host,"napi_set_named_property")))return NULL;
  if(!(host_napi_throw_error=(void*)GetProcAddress(host,"napi_throw_error")))return NULL;
  napi_value fn;
  if(napi_create_function(env,"handle",NAPI_AUTO_LENGTH,operation,NULL,&fn)!=napi_ok ||
     napi_set_named_property(env,exports,"handle",fn)!=napi_ok) return NULL;
  return exports;
}
