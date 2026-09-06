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
    modalEl.addClass("vault-relay-modal-sm");

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
      cancelBtn.buttonEl.addClass("vault-relay-btn-lg");
    });

    buttonRow.addButton((confirmBtn) => {
      confirmBtn.setButtonText("Clear Token");
      const btn = confirmBtn as unknown as Record<string, (() => void) | undefined>;
      if (typeof btn["setDestructive"] === "function") {
        btn["setDestructive"]();
      } else {
        confirmBtn.buttonEl.addClass("mod-warning");
      }
      confirmBtn.setCta();
      confirmBtn.onClick(async () => {
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
      confirmBtn.buttonEl.addClass("vault-relay-btn-lg");
    });
  }

  public onClose(): void {
    this.contentEl.empty();
  }
}
