#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <userenv.h>
#include <wchar.h>
#include <stdio.h>
#define NAPI_EXTERN
#include "node_api.h"

#define DECL(name) static __typeof__(&name) f_##name
DECL(napi_get_cb_info); DECL(napi_get_value_string_utf16); DECL(napi_get_value_int32);
DECL(napi_create_string_utf8); DECL(napi_call_function); DECL(napi_create_function);
DECL(napi_set_named_property); DECL(napi_throw_error); DECL(napi_is_exception_pending);
typedef NTSTATUS (NTAPI *OpenRelative)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
  PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
#define OK(condition) if (!(condition)) goto done
#define N(call) OK(f_##call == napi_ok)
static int below(const WCHAR *p, const WCHAR *base) {
  size_t n=wcslen(base);
  return n && !_wcsnicmp(p, base, n) && (p[n]==0 || p[n]==L'\\');
}
static int outsideOtherProfiles(const WCHAR *path, const WCHAR *home) {
  HKEY list;
  if(RegOpenKeyExW(HKEY_LOCAL_MACHINE,
      L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList",
      0,KEY_ENUMERATE_SUB_KEYS|KEY_WOW64_64KEY,&list)!=ERROR_SUCCESS)return 0;
  int result=0;
  WCHAR *profile=HeapAlloc(GetProcessHeap(),0,32768*sizeof(WCHAR));
  if(!profile){RegCloseKey(list);return 0;}
  for(DWORD i=0;;i++) {
    WCHAR key[256]; DWORD len=256;
    LSTATUS st=RegEnumKeyExW(list,i,key,&len,NULL,NULL,NULL,NULL);
    if(st==ERROR_NO_MORE_ITEMS){result=1;break;}
    if(st!=ERROR_SUCCESS)break;
    DWORD size=32768*sizeof(WCHAR);
    st=RegGetValueW(list,key,L"ProfileImagePath",RRF_RT_REG_SZ|RRF_RT_REG_EXPAND_SZ,NULL,profile,&size);
    if(st==ERROR_FILE_NOT_FOUND)continue;
    if(st!=ERROR_SUCCESS)break;
    size_t n=wcslen(profile);
    while(n && (profile[n-1]==L'\\' || profile[n-1]==L'/'))profile[--n]=0;
    if(n && _wcsicmp(profile,home) && below(path,profile))break;
  }
  HeapFree(GetProcessHeap(),0,profile);
  RegCloseKey(list);
  return result;
}
static int dirinfo(HANDLE h, FILE_ID_INFO *id, FILE_BASIC_INFO *basic) {
  return GetFileInformationByHandleEx(h,FileIdInfo,id,sizeof(*id)) &&
    GetFileInformationByHandleEx(h,FileBasicInfo,basic,sizeof(*basic)) &&
    (basic->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
    !(basic->FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_OFFLINE |
      FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_ENCRYPTED)) &&
    GetFileType(h)==FILE_TYPE_DISK;
}
static napi_value pin(napi_env e, napi_callback_info cb) {
  napi_value args[3], result=NULL, key; size_t argc=3,n=0;
  HANDLE dirs[128],token=NULL; size_t count=0;
  TOKEN_USER *user=NULL; DWORD size=0; int32_t write=0;
  WCHAR *path=NULL, *actual=NULL, home[1024], profiles[1024];
  FILE_ID_INFO id; FILE_BASIC_INFO basic; int stage=0; NTSTATUS status=0;
  N(napi_get_cb_info(e,cb,&argc,args,NULL,NULL)); OK(argc==3);
  OK((path=HeapAlloc(GetProcessHeap(),0,32768*sizeof(WCHAR))) &&
     (actual=HeapAlloc(GetProcessHeap(),0,32768*sizeof(WCHAR))));
  N(napi_get_value_string_utf16(e,args[0],(char16_t*)path,32768,&n));
  N(napi_get_value_int32(e,args[1],&write));
  OK(n>=4 && n<32767 && n==wcslen(path) && path[1]==L':' && path[2]==L'\\' && (write>=0 && write<=3));
  stage=1;
  OK(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token));
  GetTokenInformation(token,TokenUser,NULL,0,&size);
  OK(size && (user=HeapAlloc(GetProcessHeap(),0,size)) &&
    GetTokenInformation(token,TokenUser,user,size,&size));
  size=1024; OK(GetUserProfileDirectoryW(token,home,&size));
  size=1024; OK(GetProfilesDirectoryW(profiles,&size));
  stage=5;
  OK(outsideOtherProfiles(path,home));
  stage=2;
  WCHAR drive[4]={path[0],L':',L'\\',0}, fs[16];
  OK(GetDriveTypeW(drive)==DRIVE_FIXED && GetVolumeInformationW(drive,NULL,0,NULL,NULL,NULL,fs,16) &&
     !_wcsicmp(fs,L"NTFS"));
  HANDLE h=CreateFileW(drive,FILE_TRAVERSE|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,
    NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,NULL);
  OK(h!=INVALID_HANDLE_VALUE); dirs[count++]=h;
  OK(dirinfo(h,&id,&basic));
  OpenRelative open=(OpenRelative)GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtCreateFile");
  OK(open);
  for(WCHAR *part=path+3;;) {
    stage=3;
    WCHAR *next=wcschr(part,L'\\');
    if(next)*next=0;
    size_t len=wcslen(part);
    OK(count<128 && len && len<=255 && part[len-1]!=L'.' && part[len-1]!=L' ' &&
      !wcspbrk(part,L":/*?\"<>|"));
    UNICODE_STRING name={(USHORT)(len*2),(USHORT)(len*2),part};
    OBJECT_ATTRIBUTES obj={.Length=sizeof(obj),.RootDirectory=dirs[count-1],.ObjectName=&name,.Attributes=0x1040};
    IO_STATUS_BLOCK io;
    ACCESS_MASK access=READ_CONTROL|FILE_READ_ATTRIBUTES|FILE_TRAVERSE|SYNCHRONIZE;
    if(!next) access|=FILE_LIST_DIRECTORY | ((write&1) ? FILE_ADD_FILE|FILE_ADD_SUBDIRECTORY : 0);
    status=open(&h,access,&obj,&io,NULL,0,FILE_SHARE_READ|FILE_SHARE_WRITE,1,0x200021,NULL,0);
    if(next)*next=L'\\';
    OK(status>=0); dirs[count++]=h;
    stage=4;
    OK(dirinfo(h,&id,&basic));
    DWORD found=GetFinalPathNameByHandleW(h,actual,32768,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
    OK(found>4 && found<32768 && wcsncmp(actual,L"\\\\?\\",4)==0);
    // Require canonical relative components: no short names or substituted aliases.
    size_t prefix=next?(size_t)(next-path):n;
    OK(found==prefix+4 && !_wcsnicmp(actual+4,path,prefix));
    stage=5;
    // The profile container is never an eligible root, and another profile cannot be traversed.
    int selfProfile=below(actual+4,home);
    if(below(actual+4,profiles)) OK(selfProfile || (next && !_wcsicmp(actual+4,profiles)));
    PSID owner=NULL; PSECURITY_DESCRIPTOR sd=NULL;
    OK(GetSecurityInfo(h,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION,&owner,NULL,NULL,NULL,&sd)==ERROR_SUCCESS);
    int own=owner && EqualSid(owner,user->User.Sid);
    int builtin=owner && (IsWellKnownSid(owner,WinLocalSystemSid) || IsWellKnownSid(owner,WinBuiltinAdministratorsSid));
    if(sd)LocalFree(sd);
    OK(own || (builtin && (next || selfProfile)));
    if(!next) {
      OK((write&2) || _wcsicmp(actual+4,home)!=0);
      break;
    }
    part=next+1;
  }
  stage=6;
  char idstr[110];
  int pos=snprintf(idstr,sizeof(idstr),"%llx:",(unsigned long long)id.VolumeSerialNumber);
  int any=0;
  for(int i=0;i<16;i++) {
    any|=id.FileId.Identifier[i];
    pos+=snprintf(idstr+pos,sizeof(idstr)-pos,"%02x",id.FileId.Identifier[i]);
  }
  OK(any && basic.CreationTime.QuadPart);
  snprintf(idstr+pos,sizeof(idstr)-pos,":%llx",(unsigned long long)basic.CreationTime.QuadPart);
  N(napi_create_string_utf8(e,idstr,NAPI_AUTO_LENGTH,&key));
  N(napi_call_function(e,key,args[2],1,&key,&result));
done:
  while(count)CloseHandle(dirs[--count]);
  if(actual)HeapFree(GetProcessHeap(),0,actual);
  if(path)HeapFree(GetProcessHeap(),0,path);
  if(user)HeapFree(GetProcessHeap(),0,user);
  if(token)CloseHandle(token);
  if(!result) {
    bool pending=false; f_napi_is_exception_pending(e,&pending);
    if(!pending) {
      char message[128];
      snprintf(message,sizeof(message),"目录权限、身份或本地 NTFS 路径无法核实（%d / 0x%08lx）",stage,(unsigned long)status);
      f_napi_throw_error(e,NULL,message);
    }
  }
  return result;
}
NAPI_MODULE_INIT() {
  HMODULE host=GetModuleHandleW(NULL);
  #define LOAD(name) if(!(f_##name=(void*)GetProcAddress(host,#name)))return NULL
  LOAD(napi_get_cb_info); LOAD(napi_get_value_string_utf16); LOAD(napi_get_value_int32);
  LOAD(napi_create_string_utf8); LOAD(napi_call_function); LOAD(napi_create_function);
  LOAD(napi_set_named_property); LOAD(napi_throw_error); LOAD(napi_is_exception_pending);
  napi_value fn;
  if(f_napi_create_function(env,"pin",NAPI_AUTO_LENGTH,pin,NULL,&fn)!=napi_ok ||
     f_napi_set_named_property(env,exports,"pin",fn)!=napi_ok)return NULL;
  return exports;
}
