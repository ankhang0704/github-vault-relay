# GitHub Vault Relay: C6 Real-Device Manual Acceptance Test Matrix

> **Executable Protocol for Checkpoint 6 (C6) Real Runtime Acceptance**  
> **Target Release:** `0.6.0` Release Candidate (Pre-release)  
> **Build Identity:**  
> - Version: `0.6.0`  
> - `main.js` Length: 161,552 bytes  
> - `main.js` SHA-256: `8D7799BE84AAEFCD5C2A910F30125E074FD84F8D78702448271110F902DB3EE4`  
> - `styles.css` Length: 1,633 bytes  
> - `styles.css` SHA-256: `2A659A4B6B35A72EE3EF616B6202393197D39680478B961FD68A44D140954EED`  

---

## Focused Windows UI Retest Suite (UI-W1 .. UI-W7)

Execute this focused UI validation first before resuming runtime acceptance:

| ID | Focus Scenario | Action | Expected Result | Status |
| :--- | :--- | :--- | :--- | :--- |
| **UI-W1** | Local Delete Preview Wording | Delete a synced local note; click Preview / Dashboard | Preview clearly states **"Delete from GitHub"** (not "Local Del" or "LOCAL_DELETED"). | **NOT RUN** |
| **UI-W2** | Remote Delete Preview Wording | Delete a synced note on GitHub; click Preview / Dashboard | Preview clearly states **"Remove locally"** (not "Remote Del" or "REMOTE_DELETED"). | **NOT RUN** |
| **UI-W3** | Push/Pull Confirmation Delete Count | Open Pull Confirm or Push Confirm with pending deletions | Shows explicit destructive warning box with delete count and trash / Git history explanation before execution. | **NOT RUN** |
| **UI-W4** | Delete Result Badge & Count | Complete a sync that deletes a file | Pull Result displays **"Removed locally: N"**; Push Result displays **"Deleted from GitHub: N"**. Zero-delete runs do not show deletion badges. | **NOT RUN** |
| **UI-W5** | Exact Paired Move Transparency | Rename a note in Obsidian; open Preview / Dashboard | Displays primarily as **1 Move (`old → new`)**; does not double-count simultaneously as 1 Create + 1 Delete in user totals. | **NOT RUN** |
| **UI-W6** | Delete Conflict UX | Inspect a delete conflict card in Conflict Review Modal | Displays explicit side descriptions ("Deleted on this device, modified on GitHub"); actions are `[ Keep File ]`, `[ Delete File ]`, `[ Cancel ]`. | **NOT RUN** |
| **UI-W7** | Narrow Viewport & Mobile Safety | Resize Obsidian window to narrow mobile width (< 480px) | Action buttons wrap cleanly with >=44px touch targets; long paths wrap with `overflow-wrap: anywhere`; no horizontal modal overflow. | **NOT RUN** |

---

## Acceptance Execution Instructions
1. This test matrix must be executed twice:
   - **Track A:** Obsidian Desktop on Windows 10/11
   - **Track B:** Obsidian Mobile on iOS (iPhone / iPad) installed via BRAT
2. Do **NOT** mark any test as `PASS` or `FAIL` until physically tested on the real device.
3. Every test starts in the `NOT RUN` state.
4. Record actual outcomes, timestamps, and device details in the `ACTUAL RESULT` and `NOTES` columns.

---

---

## Track A: Real Windows Desktop Acceptance

| ID | Test Scenario | Precondition | Action | Expected Result | Actual Result | Status | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **RT-01** | Install/update exact 0.6.0 RC | Clean test vault or earlier version | Copy `main.js`, `manifest.json`, `styles.css` to `.obsidian/plugins/github-vault-relay/`; enable plugin | Plugin loads with version 0.6.0; console has zero fatal errors; SHA-256 matches build identity | | **NOT RUN** | |
| **RT-02** | Connection / PAT persistence | Test GitHub repo with fine-grained PAT | Enter PAT in Settings -> Connection Wizard; click **Save & Connect** | Repositories and branches discovered; repo selected; PAT stored in SecretStorage; restarts without re-prompting | | **NOT RUN** | |
| **RT-03** | Remote-only Pull | A new note `remote-sample.md` created directly on GitHub | Open Sync Dashboard -> Click **Sync** (or Safe Pull) | Note is downloaded to local vault; content is byte/LF identical; classified as `UNCHANGED` on subsequent scan | | **NOT RUN** | |
| **RT-04** | Local-only Push | A new note `local-sample.md` created in Obsidian vault | Open Sync Dashboard -> Click **Sync** | Single Git commit created on GitHub; branch ref updated (`force: false`); file appears on GitHub | | **NOT RUN** | |
| **RT-05** | Simultaneous safe changes | Note A edited on GitHub; Note B created locally | Click **[ Sync ]** | Safe Pull downloads Note A; engine replans; Safe Push commits Note B in a single commit; both succeed | | **NOT RUN** | |
| **RT-06** | Final convergence | Vault and GitHub in sync after RT-05 | Click **[ Sync ]** again | Zero items to sync; operation reports 0 pulled, 0 pushed; dashboard shows all notes `UNCHANGED` | | **NOT RUN** | |
| **RT-07** | Conflict: Keep Local | Note C edited on GitHub AND locally since last sync | Review Conflicts -> Click **Keep Local** | Revalidates remote HEAD; scoped push updates GitHub with local version; conflict record cleared | | **NOT RUN** | |
| **RT-08** | Conflict: Use Remote | Note D edited on GitHub AND locally since last sync | Review Conflicts -> Click **Use Remote** | Re-verifies local file; overwrites local file with remote version; conflict record cleared | | **NOT RUN** | |
| **RT-09** | Conflict: Keep Both | Note E edited on GitHub AND locally since last sync | Review Conflicts -> Click **Keep Both** | Local note remains intact; remote version saved as `Note E (remote conflict ...).md`; both tracked in state | | **NOT RUN** | |
| **RT-10** | Stale conflict revalidation | Active conflict in review modal | Edit local note in external editor while review modal open; click **Keep Local** | Resolution aborts with notice stating local file changed; forces user to re-review | | **NOT RUN** | |
| **RT-11** | Double Sync / Mutation lock | Large push or sync in progress | Click **Sync** button multiple times rapidly, or trigger Sync command palette | First sync executes; subsequent triggers reject immediately with active lease notice; zero duplicate commits | | **NOT RUN** | |
| **RT-12** | Offline failure & recovery | Disable network / Wi-Fi | Click **Sync** | Fails fast with descriptive network error; zero local files corrupted; state.json untouched; recovers on reconnect | | **NOT RUN** | |
| **RT-13** | Restart / kill & reopen | Sync completed | Force close Obsidian; relaunch app | Plugin loads cleanly; state.json intact; no crash loops; orphan GC runs cleanly in background | | **NOT RUN** | |
| **RT-14** | Binary byte exactness | Add PNG and PDF files to vault | Trigger Safe Push; verify blob on GitHub; pull to clean vault | Binary byte lengths and SHA-256 match original files byte-for-byte; no character encoding corruption | | **NOT RUN** | |
| **RT-15** | Large binary <= 25 MiB | Add ~20 MiB video or zip file | Trigger Safe Push | File uploaded successfully within 25 MiB ceiling; Git blob created and verified | | **NOT RUN** | |
| **RT-16** | > 25 MiB blocked | Add 30 MiB file | Trigger Safe Push | Push halts for oversized file; informative warning displayed; remote repository remains uncorrupted | | **NOT RUN** | |
| **RT-17** | Nested paths & Unicode | Create note `Folder/Subfolder/Tiếng Việt — 日本語 2026.md` | Trigger Safe Push and subsequent Pull | Directory structure created on GitHub; file pulled cleanly with Unicode characters intact | | **NOT RUN** | |
| **RT-18** | External Git writer | Push commit from native Git CLI while Obsidian open | Trigger Sync in Obsidian | Remote HEAD advancement detected; Sync pulls new commit; zero history overwrite | | **NOT RUN** | |
| **RT-19** | Internal storage cleanup | After multiple syncs and conflict resolutions | Inspect `.obsidian/github-vault-relay/` | Contains only `state.json` and active metadata; zero orphaned payloads in `conflicts/` | | **NOT RUN** | |
| **RT-20** | SecretStorage / Clear Token | Plugin configured with token | Settings -> Advanced / Security -> Click **Clear Token** -> Confirm | Modal warns of consequence; token cleared from SecretStorage; wizard reverts to disconnected state | | **NOT RUN** | |
| **RT-21** | Layout & responsiveness | Resize Obsidian window to narrow width | Inspect all modals and settings | No horizontal clipping; word-wrap functions; buttons remain accessible | | **NOT RUN** | |
| **RT-22** | Final clean convergence | End of baseline acceptance run | Restart Obsidian; open Preview | All notes categorized as `UNCHANGED`; zero warnings; vault fully operational | | **NOT RUN** | |
| **RT-23** | Local delete push | Delete synchronized note `NoteA.md` in Obsidian | Open Sync Dashboard -> Click **Sync** | Git commit created omitting `NoteA.md` via `sha: null`; ref updated `force: false`; removed from baseline; absent on GitHub | | **NOT RUN** | |
| **RT-24** | Remote delete pull | Delete synchronized note `NoteB.md` directly on GitHub | Open Sync Dashboard -> Click **Sync** | Recovery snapshot created; local `NoteB.md` removed; verified absent; baseline updated; recovery snapshot cleaned | | **NOT RUN** | |
| **RT-25** | Both deleted convergence | Note `NoteC.md` deleted both on GitHub and locally | Open Sync Dashboard -> Click **Sync** | Classified as `DELETED`; baseline entry pruned safely without remote or local mutation | | **NOT RUN** | |
| **RT-26** | Delete conflict (Local Del vs Remote Mod) | `NoteD.md` deleted locally, modified on GitHub | Review Conflicts -> Inspect options | Shows `DELETE_CONFLICT`; `[ Keep File ]` restores remote modified version; `[ Delete File ]` authorizes remote deletion | | **NOT RUN** | |
| **RT-27** | Delete conflict (Remote Del vs Local Mod) | `NoteE.md` deleted on GitHub, modified locally | Review Conflicts -> Inspect options | Shows `DELETE_CONFLICT`; `[ Keep File ]` pushes local modified version; `[ Delete File ]` authorizes local deletion | | **NOT RUN** | |
| **RT-28** | Clean local move | Move `FolderA/NoteF.md` to `FolderB/NoteF.md` in Obsidian | Open Sync Dashboard -> Click **Sync** | Emitted as single Git commit (`delete old` + `add new`); preview shows `Moved: FolderA/NoteF.md → FolderB/NoteF.md` | | **NOT RUN** | |
| **RT-29** | Remote move pull ordering | Move `DocX.md` to `Archive/DocX.md` on GitHub | Open Sync Dashboard -> Click **Sync** | Destination written and verified before source deleted; both operations succeed in order | | **NOT RUN** | |
| **RT-30** | Directory move (10 files) | Rename directory with 10 notes | Open Sync Dashboard -> Click **Sync** | All 10 path transforms batched into ONE atomic Git commit | | **NOT RUN** | |
| **RT-31** | Binary move & delete | Move/delete PNG image in Obsidian | Open Sync Dashboard -> Click **Sync** | Binary delete omitted from tree; binary move pushed as byte-exact delete + add in single commit | | **NOT RUN** | |
| **RT-32** | Crash recovery of interrupted delete | Inject pending recovery snapshot in `delete-recovery/` | Relaunch Obsidian | Startup scan restores local file from snapshot; zero silent file loss | | **NOT RUN** | |

---

## Track B: Real iPhone Mobile Acceptance (via BRAT)

| ID | Test Scenario | Precondition | Action | Expected Result | Actual Result | Status | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **RT-01** | Install exact 0.6.0 RC via BRAT | Obsidian on iOS with BRAT installed | BRAT -> Add Beta Plugin -> `https://github.com/ankhang0704/github-vault-relay` | BRAT downloads release 0.6.0 assets; plugin enables cleanly on iPhone | | **NOT RUN** | |
| **RT-02** | Connection / PAT persistence | Mobile vault | Paste fine-grained PAT; click **Save & Connect** | Discovers repos/branches; token stored in iOS Keychain (SecretStorage); survives iOS app restart | | **NOT RUN** | |
| **RT-03** | Remote-only Pull | Note created on GitHub | Open Sync Dashboard -> Tap **Sync** | Note downloaded to iPhone; displays properly in Obsidian Mobile | | **NOT RUN** | |
| **RT-04** | Local-only Push | Note written on iPhone | Open Sync Dashboard -> Tap **Sync** | Single Git commit pushed to GitHub over cellular/Wi-Fi; ref updated safely | | **NOT RUN** | |
| **RT-05** | Simultaneous safe changes | Remote note updated; local note created | Tap **[ Sync ]** | Pulls remote note, replans, pushes local note in single commit; truthful progress phases visible | | **NOT RUN** | |
| **RT-06** | Final convergence | Vault in sync | Tap **[ Sync ]** again | 0 pulled, 0 pushed; dashboard confirms all notes `UNCHANGED` | | **NOT RUN** | |
| **RT-07** | Conflict: Keep Local | Conflict generated on a note | Open Conflict Review -> Tap **Keep Local** | Scoped push updates GitHub with iPhone version; conflict removed | | **NOT RUN** | |
| **RT-08** | Conflict: Use Remote | Conflict generated on a note | Open Conflict Review -> Tap **Use Remote** | Overwrites iPhone note with remote version; pre-write backup preserved; conflict removed | | **NOT RUN** | |
| **RT-09** | Conflict: Keep Both | Conflict generated on a note | Open Conflict Review -> Tap **Keep Both** | Local note preserved; remote conflict copy created with timestamp suffix | | **NOT RUN** | |
| **RT-10** | Stale conflict revalidation | Active conflict in review modal | Switch apps, edit file in text editor, return to Obsidian, tap **Keep Local** | Revalidation halts resolution safely; warns file changed | | **NOT RUN** | |
| **RT-11** | Double Sync / Mutation lock | Sync in flight | Tap Sync button multiple times | Button disabled or lease error shown; zero duplicate commits | | **NOT RUN** | |
| **RT-12** | Offline failure & recovery | Put iPhone in Airplane Mode | Tap **[ Sync ]** | Fails fast with clear notice; zero corruption; recovers when Airplane Mode disabled | | **NOT RUN** | |
| **RT-13** | iOS background interruption | Sync in flight or completed | Swipe up to home screen, lock device, reopen Obsidian | App does not crash; storage remains durable; startup check rolls back any unfinished write | | **NOT RUN** | |
| **RT-14** | Binary byte exactness | Capture camera photo in Obsidian | Tap **[ Sync ]**; verify on GitHub; view photo | Image uploaded byte-exact; full resolution image displays on GitHub and Desktop | | **NOT RUN** | |
| **RT-15** | Large binary <= 25 MiB | Import ~15 MiB PDF attachment | Tap **[ Sync ]** | PDF pushes successfully without iOS Jetsam memory kill | | **NOT RUN** | |
| **RT-16** | > 25 MiB blocked | Import > 25 MiB video | Tap **[ Sync ]** | Blocked before upload; informative user toast shown; memory protected | | **NOT RUN** | |
| **RT-17** | Nested paths & Unicode | Create note in nested folders with accents | Tap **[ Sync ]** | Path created correctly; characters display identically across mobile and desktop | | **NOT RUN** | |
| **RT-18** | External Git writer | Push commit from desktop while iPhone idle | Open iPhone Obsidian -> Tap **Sync** | iPhone safely pulls external commit without ref conflict | | **NOT RUN** | |
| **RT-19** | Internal storage cleanup | After multiple syncs | Check `.obsidian/github-vault-relay/` | Zero stale snapshots in `conflicts/`; storage bounded | | **NOT RUN** | |
| **RT-20** | SecretStorage / Clear Token | Plugin configured | Advanced / Security -> Clear Token -> Confirm | Credential wiped from iOS Keychain; UI disconnected cleanly | | **NOT RUN** | |
| **RT-21** | Mobile layout & touch targets | iPhone portrait view | Inspect all modals, buttons, and progress | Buttons meet >=44px touch height; text wraps properly; safe-area bottom inset respected | | **NOT RUN** | |
| **RT-22** | Final clean convergence | End of iPhone acceptance run | Relaunch Obsidian; open Preview | All notes `UNCHANGED`; zero errors in mobile console; vault fully operational | | **NOT RUN** | |
| **RT-23** | Local delete push | Delete synchronized note `NoteA.md` on iPhone | Open Sync Dashboard -> Tap **Sync** | Git commit created omitting `NoteA.md` via `sha: null`; ref updated `force: false`; removed from baseline | | **NOT RUN** | |
| **RT-24** | Remote delete pull | Delete synchronized note `NoteB.md` on GitHub | Open Sync Dashboard -> Tap **Sync** | Recovery snapshot created; mobile note deleted; verified absent; baseline updated; snapshot cleaned | | **NOT RUN** | |
| **RT-25** | Both deleted convergence | Note `NoteC.md` deleted on GitHub and iPhone | Open Sync Dashboard -> Tap **Sync** | Classified as `DELETED`; baseline pruned with zero mutation | | **NOT RUN** | |
| **RT-26** | Delete conflict (Local Del vs Remote Mod) | `NoteD.md` deleted on iPhone, modified on GitHub | Review Conflicts -> Inspect options | Shows `DELETE_CONFLICT`; `[ Keep File ]` restores remote modified version; `[ Delete File ]` authorizes remote deletion | | **NOT RUN** | |
| **RT-27** | Delete conflict (Remote Del vs Local Mod) | `NoteE.md` deleted on GitHub, modified on iPhone | Review Conflicts -> Inspect options | Shows `DELETE_CONFLICT`; `[ Keep File ]` pushes local modified version; `[ Delete File ]` authorizes local deletion | | **NOT RUN** | |
| **RT-28** | Clean local move | Move `FolderA/NoteF.md` to `FolderB/NoteF.md` on iPhone | Open Sync Dashboard -> Tap **Sync** | Single Git commit (`delete old` + `add new`); preview shows `Moved: FolderA/NoteF.md → FolderB/NoteF.md` | | **NOT RUN** | |
| **RT-29** | Remote move pull ordering | Move `DocX.md` to `Archive/DocX.md` on GitHub | Open Sync Dashboard -> Tap **Sync** | Destination written and verified before source deleted; both operations succeed in order | | **NOT RUN** | |
| **RT-30** | Directory move (10 files) | Rename directory with 10 notes on iPhone | Open Sync Dashboard -> Tap **Sync** | All 10 path transforms batched into ONE atomic Git commit | | **NOT RUN** | |
| **RT-31** | Binary move & delete | Move/delete photo attachment on iPhone | Open Sync Dashboard -> Tap **Sync** | Binary delete omitted from tree; binary move pushed as byte-exact delete + add in single commit | | **NOT RUN** | |
| **RT-32** | Stale device remote delete | Device offline while remote deleted file, then returns | Open Sync Dashboard -> Tap **Sync** | Correctly pulls `REMOTE_DELETED`, removes local file safely, updates baseline | | **NOT RUN** | |

---

## Acceptance Sign-Off

### Windows Desktop Sign-off:
- Tester: `____________________`
- Date: `____________________`
- Result: `[ ] PASS   [ ] FAIL`

### iPhone Mobile Sign-off:
- Tester: `____________________`
- Date: `____________________`
- Device: `____________________` (iOS version: `______`)
- Result: `[ ] PASS   [ ] FAIL`
