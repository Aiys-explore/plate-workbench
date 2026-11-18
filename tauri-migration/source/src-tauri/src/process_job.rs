use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::null;
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

pub struct ProcessJob(OwnedHandle);

fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // Each successful Win32 call here returns a handle owned by the caller.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

impl ProcessJob {
    pub fn new() -> io::Result<Self> {
        let handle = owned(unsafe { CreateJobObjectW(null(), null()) })?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let result = unsafe {
            SetInformationJobObject(handle.as_raw_handle(), JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32)
        };
        if result == 0 { return Err(io::Error::last_os_error()); }
        Ok(Self(handle))
    }

    pub fn attach_before_resume(&self, child: &tokio::process::Child) -> io::Result<()> {
        let process = child.raw_handle().ok_or_else(|| io::Error::other("缺少子进程句柄"))?;
        let pid = child.id().ok_or_else(|| io::Error::other("缺少子进程 ID"))?;
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // CREATE_SUSPENDED gives the child one initial thread; no child code has run yet.
        let snapshot = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
        let mut row: THREADENTRY32 = unsafe { zeroed() };
        row.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut row) };
        while found != 0 {
            if row.th32OwnerProcessID == pid {
                let thread = owned(unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, row.th32ThreadID) })?;
                return match unsafe { ResumeThread(thread.as_raw_handle()) } {
                    1 => Ok(()),
                    u32::MAX => Err(io::Error::last_os_error()),
                    _ => Err(io::Error::other("子进程线程挂起计数异常")),
                };
            }
            row.dwSize = size_of::<THREADENTRY32>() as u32;
            found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut row) };
        }
        Err(io::Error::other("找不到刚启动的子进程线程"))
    }

    pub fn terminate(&self) -> io::Result<()> {
        if self.active_count()? == 0 || unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } != 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    pub fn active_count(&self) -> io::Result<u32> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        let ok = unsafe {
            QueryInformationJobObject(self.0.as_raw_handle(), JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32, std::ptr::null_mut())
        };
        if ok == 0 { return Err(io::Error::last_os_error()); }
        Ok(info.ActiveProcesses)
    }
}
