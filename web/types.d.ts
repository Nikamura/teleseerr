interface TelegramWebApp {
  ready(): void;
  expand(): void;
  initData: string;
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
