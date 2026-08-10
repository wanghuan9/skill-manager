import type { ReactNode } from "react";
import type { PublishingPlatformAdapter } from "./publishing-adapter";

export type PublishingAuthenticationProps = {
  refreshAuth: () => Promise<void>;
};

export type PublishingPlatformRegistration = {
  adapter: PublishingPlatformAdapter;
  order: number;
  isDefault?: boolean;
  badgeLabel: string;
  authorizationActionLabel: string;
  renderAuthentication: (props: PublishingAuthenticationProps) => ReactNode;
  manageAuthorization: () => void | Promise<void>;
};

export type PublishingPlatformRegistrationModule = {
  default: PublishingPlatformRegistration;
};
