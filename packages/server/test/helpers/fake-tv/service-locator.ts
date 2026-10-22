// The service locator of the app (module 948235 of the web build), a module that exports hasService,
// service, serviceOrNull, registerService, unregisterService and waitServiceRegistered, keyed by
// service descriptors (createServiceDescriptor returns the name it is given). service throws for a
// descriptor nothing is registered for; serviceOrNull answers null for it. The parts of the fake app
// that the app registers a service for at boot provide it here: the page layout service
// (pine-editor.ts) and the services of the watchlists (watchlists.ts). A page that calls
// registerService or unregisterService itself is recorded and changes nothing.

export interface FakeServiceLocator {
  // The webpack module of the locator, by module ID.
  readonly modules: Record<string, Record<string, unknown>>;
  // Registers `service` under `descriptor`, as the app does when it boots.
  provide: (descriptor: unknown, service: unknown) => void;
}

export function createFakeServiceLocator(
  record: (name: string, args: readonly unknown[]) => void,
): FakeServiceLocator {
  const services = new Map<unknown, unknown>();
  const hasService = (descriptor: unknown): boolean => services.has(descriptor);
  return {
    modules: {
      // Module IDs are arbitrary numbers, as in a production build.
      '70455': {
        hasService,
        service(descriptor: unknown) {
          if (!hasService(descriptor)) {
            throw new Error('Service not found');
          }
          return services.get(descriptor);
        },
        serviceOrNull: (descriptor: unknown) => services.get(descriptor) ?? null,
        registerService(...args: unknown[]) {
          record('registerService', args);
        },
        unregisterService(...args: unknown[]) {
          record('unregisterService', args);
        },
        waitServiceRegistered: (descriptor: unknown) => Promise.resolve(services.get(descriptor)),
      },
    },
    provide: (descriptor, service) => {
      services.set(descriptor, service);
    },
  };
}
