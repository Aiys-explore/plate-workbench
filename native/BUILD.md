
The checked-in win-x64 addon is the Electron package resource. Its SHA-256 is
pinned in managed-delete-file.ts and also checked against the release inventory.
It has no external executable or Node installation requirement. Its Node-API
symbols are obtained from the Electron host process instead of importing
node.exe, since the product executable is named NotesAgentWorkbench.exe.

Build tool only: Zig 0.15.2 Windows x64, official ZIP SHA-256
3a0ed1e8799a2f8ce2a6e6290a9ff22e6906f8227865911fb7ddedc3cc14cb0c.
Headers: Electron 44.11.3 include/node. From source root:

    zig cc -shared -O2 -target x86_64-windows-gnu -I<ELECTRON_HEADERS>/include/node -DNAPI_VERSION=8 native/managed.c -lkernel32 -o native/managed.node

After rebuilding, review compiler and output identity, update the product pin,
rebuild the Windows package, and replay the packaged tests. The checked-in
binary remains the freeze input; the verifier compares it to the package bytes.

M4.4 extends the same addon with handle-relative trusted-ancestor checks
(mode 5) and identity/stamp-checked removal of its private stage (mode 4).
Publication uses the existing mode 1 non-replacing handle-relative rename.
The frozen Windows package loads this binary through the checked-in SHA pin.

P13 first-run directory identity (new independent win-x64 addon)

    zig cc -shared -O2 -target x86_64-windows-gnu -I<ELECTRON_HEADERS>/include/node -DNAPI_VERSION=8 native/firstrun-directory.c -lkernel32 -ladvapi32 -luserenv -o native/firstrun-directory.node

The managed-file addon is unchanged. Only firstrun-directory.node is shipped
from the new build; .lib/.pdb are compiler byproducts. FirstRun verifies this
resource by SHA-256 before loading it. The addon opens fixed NTFS paths through
directory handles, rejects reparse/alias paths, obtains the current profile and
SID from the process token, checks registered profile boundaries and owner SIDs,
and requests directory write rights only for commit. Candidate checks do not
create probe files. The pin callback is synchronous; the handles intentionally
deny delete sharing for the duration of the callback.
