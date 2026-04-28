import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type NotificationTone = "success" | "error" | "info";

type AppNotification = {
  id: number;
  exiting: boolean;
  message: string;
  tone: NotificationTone;
};

type NotifyInput = {
  message: string;
  tone?: NotificationTone;
};

type NotificationContextValue = {
  notify: (input: NotifyInput) => void;
};

const AUTO_DISMISS_DELAY_MS = 4500;
const EXIT_ANIMATION_DELAY_MS = 180;
const NotificationContext = createContext<NotificationContextValue | null>(null);

type NotificationProviderProps = {
  children: ReactNode;
};

export function NotificationProvider({ children }: NotificationProviderProps) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const dismissTimers = useRef(new Map<number, number>());
  const exitTimers = useRef(new Map<number, number>());

  const dismiss = useCallback((notificationId: number) => {
    const timerId = dismissTimers.current.get(notificationId);
    if (timerId) {
      window.clearTimeout(timerId);
      dismissTimers.current.delete(notificationId);
    }

    setNotifications((current) =>
      current.map((notification) =>
        notification.id === notificationId ? { ...notification, exiting: true } : notification,
      ),
    );

    const exitTimerId = window.setTimeout(() => {
      exitTimers.current.delete(notificationId);
      setNotifications((current) => current.filter((notification) => notification.id !== notificationId));
    }, EXIT_ANIMATION_DELAY_MS);
    exitTimers.current.set(notificationId, exitTimerId);
  }, []);

  const notify = useCallback((input: NotifyInput) => {
    const notificationId = Date.now() + Math.random();
    const notification: AppNotification = {
      id: notificationId,
      exiting: false,
      message: input.message,
      tone: input.tone ?? "info",
    };

    setNotifications((current) => [...current, notification]);
    const timerId = window.setTimeout(() => dismiss(notificationId), AUTO_DISMISS_DELAY_MS);
    dismissTimers.current.set(notificationId, timerId);
  }, [dismiss]);

  useEffect(() => () => {
    dismissTimers.current.forEach((timerId) => window.clearTimeout(timerId));
    exitTimers.current.forEach((timerId) => window.clearTimeout(timerId));
    dismissTimers.current.clear();
    exitTimers.current.clear();
  }, []);

  const value = useMemo<NotificationContextValue>(() => ({ notify }), [notify]);

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <div className="app-notification-stack" aria-live="polite" aria-relevant="additions">
        {notifications.map((notification) => (
          <div
            key={notification.id}
            className={`app-notification app-notification--${notification.tone}${
              notification.exiting ? " is-exiting" : ""
            }`}
            role={notification.tone === "error" ? "alert" : "status"}
          >
            <NotificationIcon tone={notification.tone} />
            <span className="app-notification__message">{notification.message}</span>
            <button
              className="app-notification__close"
              type="button"
              aria-label="关闭通知"
              onClick={() => dismiss(notification.id)}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path
                  d="m5.5 5.5 9 9m0-9-9 9"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth="1.8"
                />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error("useNotifications must be used inside NotificationProvider");
  }

  return context;
}

function NotificationIcon(props: { tone: NotificationTone }) {
  const { tone } = props;
  if (tone === "error") {
    return (
      <svg className="app-notification__icon" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="m7.5 7.5 5 5m0-5-5 5" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      </svg>
    );
  }

  if (tone === "success") {
    return (
      <svg className="app-notification__icon" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" strokeWidth="2" />
        <path
          d="m6.3 10.2 2.4 2.3 5-5.4"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </svg>
    );
  }

  return (
    <svg className="app-notification__icon" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M10 9.2v4.2m0-6.8h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}
