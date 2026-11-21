const dev = process.env.NODE_ENV === 'development';
const apiOrigin = process.env.DESK_API_URL ?? 'http://localhost:8080';

const mock = process.env.NEXT_PUBLIC_MOCK === '1';

/** Static export served by the API from the same origin. In `next dev` only, /api is proxied to DESK_API_URL. */
const config = {
  ...(dev
    ? { rewrites: async () => [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }] }
    : { output: 'export' }),
  // Mock fixtures are only bundled in a mock build; production resolves `desk-mock` to a stub.
  turbopack: { resolveAlias: { 'desk-mock': mock ? './lib/mock/handler.ts' : './lib/mock/off.ts' } },
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
};
export default config;
