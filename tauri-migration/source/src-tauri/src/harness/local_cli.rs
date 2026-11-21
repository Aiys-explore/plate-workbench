use std::ffi::{c_void, OsStr, OsString};
use std::fs;
use std::io;
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    LocalFree, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSidToSidW};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile,
    DeriveAppContainerSidFromAppContainerName, GetAppContainerFolderPath,
};
use windows_sys::Win32::Security::{FreeSid, PSID, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Threading::*;

pub const MODE: &str = "--plate-isolated-cli";

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn wide_string(ptr: *const u16) -> OsString {
    let mut len = 0;
    // Win32 returns a valid, NUL-terminated string belonging to the caller.
    while unsafe { *ptr.add(len) } != 0 {
        len += 1;
    }
    OsString::from_wide(unsafe { std::slice::from_raw_parts(ptr, len) })
}

fn win_bool(value: i32) -> io::Result<()> {
    if value == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn hr(result: i32) -> io::Result<()> {
    if result < 0 {
        Err(io::Error::other(format!("Windows HRESULT 0x{result:08x}")))
    } else {
        Ok(())
    }
}

struct ContainerSid(PSID);
impl Drop for ContainerSid {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                FreeSid(self.0);
            }
        }
    }
}

struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

pub struct Profile {
    name: String,
    pub home: PathBuf,
}
impl Profile {
    pub fn create() -> io::Result<Self> {
        let name = format!("Plate.Workbench.{}", uuid::Uuid::new_v4());
        let name_wide = wide(&name);
        let mut sid = ContainerSid(null_mut());
        hr(unsafe {
            CreateAppContainerProfile(
                name_wide.as_ptr(),
                wide("Plate workbench task").as_ptr(),
                wide("Temporary Plate execution profile").as_ptr(),
                null(),
                0,
                &mut sid.0,
            )
        })?;
        let mut profile = Self {
            name,
            home: PathBuf::new(),
        };
        let mut sid_text = null_mut();
        win_bool(unsafe { ConvertSidToStringSidW(sid.0, &mut sid_text) })?;
        let _sid_text = LocalAllocation(sid_text.cast());
        let mut location = null_mut();
        hr(unsafe { GetAppContainerFolderPath(sid_text, &mut location) })?;
        if location.is_null() {
            return Err(io::Error::other("AppContainer 未返回工作目录"));
        }
        profile.home = PathBuf::from(wide_string(location));
        unsafe {
            CoTaskMemFree(location.cast());
        }
        Ok(profile)
    }

    pub fn launcher(
        &self,
        exe: &Path,
        args: &[OsString],
        network: bool,
        shell: bool,
    ) -> io::Result<tokio::process::Command> {
        let directory = self.home.join("PlateTask");
        fs::create_dir_all(&directory)?;
        let name = exe
            .file_name()
            .ok_or_else(|| io::Error::other("缺少 CLI 文件名"))?;
        let executable = directory.join(name);
        fs::copy(exe, &executable)?;
        let temp = self.home.join("Temp");
        fs::create_dir_all(&temp)?;
        let mut command = tokio::process::Command::new(std::env::current_exe()?);
        command
            .env_clear()
            .env("LOCALAPPDATA", &self.home)
            .env("APPDATA", &self.home)
            .env("USERPROFILE", &self.home)
            .env("TMP", &temp)
            .env("TEMP", &temp);
        if let Some(system) = std::env::var_os("SystemRoot") {
            command
                .env("SystemRoot", &system)
                .env("WINDIR", &system)
                .env("PATH", PathBuf::from(system).join("System32"));
        }
        command
            .arg(MODE)
            .arg(&self.name)
            .arg(if network { "1" } else { "0" })
            .arg(if shell { "1" } else { "0" })
            .arg(executable)
            .args(args);
        Ok(command)
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        unsafe {
            DeleteAppContainerProfile(wide(&self.name).as_ptr());
        }
    }
}

struct Attributes {
    // Aligned storage is retained for the lifetime of the native attribute list.
    _memory: Vec<usize>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    fn new(count: u32) -> io::Result<Self> {
        let mut size = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut size);
        }
        if size == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut memory = vec![0usize; size.div_ceil(size_of::<usize>())];
        let list = memory.as_mut_ptr().cast();
        win_bool(unsafe { InitializeProcThreadAttributeList(list, count, 0, &mut size) })?;
        Ok(Self {
            _memory: memory,
            list,
        })
    }

    fn set<T>(&self, key: u32, value: &T) -> io::Result<()> {
        win_bool(unsafe {
            UpdateProcThreadAttribute(
                self.list,
                0,
                key as usize,
                (value as *const T).cast(),
                size_of::<T>(),
                null_mut(),
                null(),
            )
        })
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.list);
        }
    }
}

fn quote(out: &mut Vec<u16>, value: &OsStr) {
    const QUOTE: u16 = b'"' as u16;
    const SLASH: u16 = b'\\' as u16;
    out.push(QUOTE);
    let mut slashes = 0;
    for ch in value.encode_wide() {
        if ch == SLASH {
            slashes += 1;
            continue;
        }
        out.extend(std::iter::repeat_n(
            SLASH,
            if ch == QUOTE {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        slashes = 0;
        out.push(ch);
    }
    out.extend(std::iter::repeat_n(SLASH, slashes * 2));
    out.push(QUOTE);
}

fn start(args: Vec<OsString>) -> io::Result<i32> {
    let [profile, network, shell, exe, rest @ ..] = args.as_slice() else {
        return Err(io::Error::other("AppContainer 启动参数不完整"));
    };
    let profile = profile.to_string_lossy();
    if !profile
        .strip_prefix("Plate.Workbench.")
        .is_some_and(|suffix| uuid::Uuid::parse_str(suffix).is_ok())
    {
        return Err(io::Error::other("AppContainer 标识无效"));
    }
    let mut sid = ContainerSid(null_mut());
    hr(unsafe {
        DeriveAppContainerSidFromAppContainerName(wide(profile.as_ref()).as_ptr(), &mut sid.0)
    })?;
    let mut internet = LocalAllocation(null_mut());
    let mut capabilities = [SID_AND_ATTRIBUTES {
        Sid: null_mut(),
        Attributes: 4,
    }];
    if network == "1" {
        // Well-known AppContainer internetClient capability.
        win_bool(unsafe { ConvertStringSidToSidW(wide("S-1-15-3-1").as_ptr(), &mut internet.0) })?;
        capabilities[0].Sid = internet.0;
    }
    let security = SECURITY_CAPABILITIES {
        AppContainerSid: sid.0,
        Capabilities: if network == "1" {
            capabilities.as_mut_ptr()
        } else {
            null_mut()
        },
        CapabilityCount: u32::from(network == "1"),
        Reserved: 0,
    };
    let handles: [HANDLE; 3] = unsafe {
        [
            GetStdHandle(STD_INPUT_HANDLE),
            GetStdHandle(STD_OUTPUT_HANDLE),
            GetStdHandle(STD_ERROR_HANDLE),
        ]
    };
    for handle in handles {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::other("任务标准管道不可用"));
        }
        win_bool(unsafe {
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
        })?;
    }
    let child_policy = 1u32; // PROCESS_CREATION_CHILD_PROCESS_RESTRICTED
    let packages_policy = 1u32; // PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT
    let attributes = Attributes::new(if shell == "1" { 3 } else { 4 })?;
    attributes.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &security)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &handles)?;
    attributes.set(
        PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
        &packages_policy,
    )?;
    if shell != "1" {
        attributes.set(PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &child_policy)?;
    }

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[2];
    startup.lpAttributeList = attributes.list;
    let mut command = Vec::new();
    quote(&mut command, exe);
    for argument in rest {
        command.push(b' ' as u16);
        quote(&mut command, argument);
    }
    command.push(0);
    let path = Path::new(exe);
    let cwd = wide(
        path.parent()
            .ok_or_else(|| io::Error::other("CLI 路径缺少目录"))?,
    );
    let mut process = PROCESS_INFORMATION::default();
    win_bool(unsafe {
        CreateProcessW(
            wide(exe).as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            DETACHED_PROCESS | EXTENDED_STARTUPINFO_PRESENT,
            null(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    })?;
    let process_handle = unsafe { OwnedHandle::from_raw_handle(process.hProcess) };
    let _thread = unsafe { OwnedHandle::from_raw_handle(process.hThread) };
    if unsafe { WaitForSingleObject(process_handle.as_raw_handle(), INFINITE) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut exit = 0;
    win_bool(unsafe { GetExitCodeProcess(process_handle.as_raw_handle(), &mut exit) })?;
    Ok(exit as i32)
}

pub fn run_if_requested() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new(MODE)) {
        return;
    }
    match start(args.collect()) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("AppContainer: {error}");
            std::process::exit(125);
        }
    }
}
