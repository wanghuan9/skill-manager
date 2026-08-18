import type { ReactNode } from "react";
import type { TranslationKey } from "@/app/i18n";
import type { PublishingPlatformAdapter } from "./publishing-adapter";

export type PublishingAuthenticationProps = {
  refreshAuth: () => Promise<void>;
};

export type PublishingPlatformRegistration = {
  adapter: PublishingPlatformAdapter;
  order: number;
  isDefault?: boolean;
  badgeLabelKey: TranslationKey;
  authorizationActionLabelKey: TranslationKey;
  renderAuthentication: (props: PublishingAuthenticationProps) => ReactNode;
  manageAuthorization: () => void | Promise<void>;
};

export type PublishingPlatformRegistrationModule = {
  default: PublishingPlatformRegistration;
};
