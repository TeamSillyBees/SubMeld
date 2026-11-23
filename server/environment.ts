export function applicationOptions() {
  return {
    directory: process.env.SUBMELD_DATA_DIR,
    binary: process.env.SUBMELD_MIHOMO_BIN,
    publicUrl: process.env.SUBMELD_PUBLIC_URL,
    secure: process.env.SUBMELD_SECURE_COOKIES === '1' ? true : undefined,
    password: process.env.SUBMELD_ADMIN_PASSWORD,
    allowPrivate: process.env.SUBMELD_ALLOW_PRIVATE_UPSTREAMS === '1',
  }
}
