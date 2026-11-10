interface TelegramPopupButton {
  id?: string;
  type?: "default" | "ok" | "close" | "cancel" | "destructive";
  text?: string;
}

interface TelegramWebApp {
  colorScheme?: "dark" | "light";
  ready(): void;
  expand(): void;
  initData: string;
  initDataUnsafe?: { user?: { allows_write_to_pm?: boolean } };
  isVersionAtLeast?(version: string): boolean;
  showPopup?(params: { title?: string; message: string; buttons?: TelegramPopupButton[] }, callback?: (buttonId: string | null) => void): void;
  enableClosingConfirmation?(): void;
  disableClosingConfirmation?(): void;
  requestWriteAccess?(callback?: (granted: boolean) => void): void;
  hideKeyboard?(): void;
  addToHomeScreen?(): void;
  checkHomeScreenStatus?(callback?: (status: "unsupported" | "unknown" | "added" | "missed") => void): void;
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
    notificationOccurred(type: "error" | "success" | "warning"): void;
    selectionChanged(): void;
  };
  BackButton: {
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
  };
}

interface Window {
  Telegram?: {
    WebApp?: TelegramWebApp;
  };
  onTelegramAuth?: (user: Record<string, unknown>) => void;
}
