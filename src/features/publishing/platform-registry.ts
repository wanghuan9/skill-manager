import type {
  PublishingPlatformRegistration,
  PublishingPlatformRegistrationModule,
} from "./publishing-platform-registration";

const registrationModules = import.meta.glob<PublishingPlatformRegistrationModule>(
  "./registrations/*.tsx",
  { eager: true },
);

function loadPublishingPlatformRegistrations(): PublishingPlatformRegistration[] {
  const registrations = Object.values(registrationModules)
    .map((module) => module.default)
    .filter(Boolean)
    .sort((left, right) => left.order - right.order);
  const platformIds = new Set<string>();
  for (const registration of registrations) {
    const platformId = registration.adapter.platform.id;
    if (platformIds.has(platformId)) {
      throw new Error(`发布平台注册重复：${platformId}`);
    }
    platformIds.add(platformId);
  }
  return registrations;
}

export const publishingPlatformRegistrations = loadPublishingPlatformRegistrations();

export function getDefaultPublishingPlatformRegistration(): PublishingPlatformRegistration {
  const registration = publishingPlatformRegistrations.find((item) => item.isDefault)
    ?? publishingPlatformRegistrations[0];
  if (!registration) {
    throw new Error("未配置发布平台。请至少注册一个发布平台。");
  }
  return registration;
}
