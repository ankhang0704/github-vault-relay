# GitHub Vault Relay: Real-Device Manual Acceptance Test Matrix

> **Executable Protocol for Real Runtime Acceptance of the current release**
> **Target Release:** `1.0.4` Stable Release
> **Build Identity:**  
> - Version: `1.0.4`
> - `main.js` Length: 169,912 bytes
> - `main.js` SHA-256: `917683089E5FDB8B049D6D4A13FE66C15362054890B93B82A2B37101391AD86B`
> - `manifest.json` Length: 350 bytes  
> - `manifest.json` SHA-256: `397FFB59B787457F70A7A939ADDD5F934C3E34DCAEE835C2B184388826AC8488`
> - `styles.css` Length: 4,222 bytes  
> - `styles.css` SHA-256: `BF3B1FA38D46DA8B21E677C443A07520C5C7152E74F9C76CFAEAF2F169CB9EAB`  
> **Automated baseline:** `npm run verify` PASS on 2026-09-06; 43 test files / 473 passing tests.
> **Real-device baseline:** `NOT RUN` in this canonical matrix. Do not infer Windows/iOS PASS from automated tests.

---

## Final Product Closure Checklist (maintainer execution required)

Run these five scenarios on a real iPhone with Obsidian Mobile and record the evidence below. These rows intentionally remain `NOT RUN` until the maintainer provides device results.

| ID | Scenario | Expected evidence | Status |
| :--- | :--- | :--- | :--- |
| **CLOSE-01** | Plugin load/setup | Plugin enables, settings open, repository/branch/PAT setup completes without fatal error. | **NOT RUN** |
| **CLOSE-02** | Pull | A remote-only note is pulled and is `UNCHANGED` on the next preview. | **NOT RUN** |
| **CLOSE-03** | Local edit → Push | A local note edit produces one safe commit/ref update and appears on GitHub. | **NOT RUN** |
| **CLOSE-04** | Remote edit → Pull | A remote note edit is pulled without overwriting unrelated local changes. | **NOT RUN** |
| **CLOSE-05** | Conflict / safe abort | Simultaneous edits preserve the conflict or abort safely; no silent overwrite occurs. | **NOT RUN** |

Maintainer evidence to record: iPhone model/iOS, Obsidian version, plugin build hash, UTC timestamp, actual result, and notes. Do not infer PASS from Vitest or desktop execution.

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
| **RT-01** | Install/update exact 1.0.4 release | Clean test vault or earlier version | Copy `main.js`, `manifest.json`, `styles.css` to `<configDir>/plugins/github-vault-relay/`; enable plugin | Plugin loads with version 1.0.4 and minimum Obsidian version 1.11.4; console has zero fatal errors; SHA-256 matches build identity | | **NOT RUN** | |
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
| **RT-19** | Internal storage cleanup | After multiple syncs and conflict resolutions | Inspect `<configDir>/github-vault-relay/` | Canonical storage is under the live config directory; no unreferenced conflict payloads or stale recovery artifacts remain after cleanup | | **NOT RUN** | |
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
| **RT-01** | Install exact 1.0.4 release via BRAT | Obsidian on iOS with BRAT installed | BRAT -> Add Beta Plugin -> `https://github.com/ankhang0704/github-vault-relay` | BRAT downloads release 1.0.4 assets; plugin enables cleanly on iPhone | | **NOT RUN** | |
| **RT-02** | Connection / PAT persistence | Mobile vault | Paste fine-grained PAT; click **Save & Connect** | Discovers repos/branches; token stored by Obsidian SecretStorage; survives iOS app restart | | **NOT RUN** | |
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
| **RT-19** | Internal storage cleanup | After multiple syncs | Check `<configDir>/github-vault-relay/` | No stale snapshots or unreferenced conflict payloads remain after cleanup | | **NOT RUN** | |
| **RT-20** | SecretStorage / Clear Token | Plugin configured | Advanced / Security -> Clear Token -> Confirm | Credential removed from Obsidian SecretStorage; UI disconnected cleanly | | **NOT RUN** | |
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

---

## Track C: C7 Empty-Repository & Zero-File Acceptance Protocol

| ID | Test Scenario | Precondition | Action | Expected Result | Actual Result | Status | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **C7-EMPTY-01** | Delete final file locally -> empty remote tree | Only 1 note in vault and on GitHub | Delete local note; click **[ Sync ]** | Commit uses Canonical Empty Tree SHA `4b825dc642cb6eb9a060e54bf8d69288fbee4904`; branch ref is non-force; baseline reaches 0 files | | **NOT RUN** | |
| **C7-EMPTY-02** | Zero-file dashboard display | Repository has 0 files (empty tree) | Open Sync Dashboard | Dashboard displays a truthful zero-file state with no pending items | | **NOT RUN** | |
| **C7-EMPTY-03** | Create first note from empty state | Repository has 0 files (empty tree) | Create `first-note.md`; click **[ Sync ]** | `createTree` uses `base_tree: CANONICAL_EMPTY_TREE_SHA`; commit/ref/baseline converge to 1 file | | **NOT RUN** | |
| **C7-EMPTY-04** | Remote final file delete pull | Only 1 note; deleted directly on GitHub | Open Sync Dashboard -> Click **[ Sync ]** | Classifies as `REMOTE_DELETED`; local file is safely trashed; baseline reaches 0 files | | **NOT RUN** | |
| **C7-EMPTY-05** | Empty-tree alternating stress cycles | Sync configured | Repeat 0 -> 1 -> 0 files create & delete cycles | Each cycle preserves branch lineage and baseline convergence | | **NOT RUN** | |

---

## Acceptance Sign-Off

### Acceptance Sign-Off

All rows above start as `NOT RUN`. A maintainer may replace a row's status only after recording the device, Obsidian version, build identity, timestamp, actual result, and notes.

Automated tests cover the implementation; they do not sign off Windows or iOS behavior. The current canonical status is therefore **real-device acceptance: NOT RUN**.
