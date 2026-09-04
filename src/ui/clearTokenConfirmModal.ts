import { App, Modal, Setting } from "obsidian";

/**
 * ClearTokenConfirmModal
 *
 * Explicit confirmation dialog before removing a GitHub Personal Access Token
 * from Obsidian SecretStorage. Prevents accidental taps on mobile/iPhone.
 */
export class ClearTokenConfirmModal extends Modal {
  private onConfirm: () => Promise<void> | void;

  constructor(app: App, onConfirm: () => Promise<void> | void) {
    super(app);
    this.onConfirm = onConfirm;
  }

  public onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("vault-relay-modal");
    contentEl.empty();
    modalEl.addClass("vault-relay-confirm-modal");
    modalEl.style.maxWidth = "480px";
    modalEl.style.width = "90vw";

    contentEl.createEl("h3", { text: "Clear Stored GitHub Token?" });

    contentEl.createEl("p", {
      text: "Are you sure you want to remove your GitHub Personal Access Token from Obsidian SecretStorage?",
      attr: { style: "line-height: 1.5; margin-bottom: 12px;" },
    });

    contentEl.createEl("p", {
      text: "This action cannot be undone. Your repository and branch settings will remain, but synchronization will require you to re-enter a token.",
      attr: { style: "color: var(--text-muted); font-size: 0.9em; margin-bottom: 20px;" },
    });

    const buttonRow = new Setting(contentEl);
    buttonRow.addButton((cancelBtn) => {
      cancelBtn.setButtonText("Cancel").onClick(() => {
        this.close();
      });
      cancelBtn.buttonEl.style.minHeight = "44px";
      cancelBtn.buttonEl.style.padding = "8px 16px";
    });

    buttonRow.addButton((confirmBtn) => {
      confirmBtn
        .setButtonText("Clear Token")
        .setWarning()
        .onClick(async () => {
          confirmBtn.setDisabled(true);
          confirmBtn.setButtonText("Clearing...");
          try {
            await this.onConfirm();
            this.close();
          } catch {
            confirmBtn.setDisabled(false);
            confirmBtn.setButtonText("Clear Token");
          }
        });
      confirmBtn.buttonEl.style.minHeight = "44px";
      confirmBtn.buttonEl.style.padding = "8px 16px";
    });
  }

  public onClose(): void {
    this.contentEl.empty();
  }
}
