const dev = process.env.NODE_ENV === 'development';
const apiOrigin = process.env.DESK_API_URL ?? 'http://localhost:8787';

/** Static export served by the API from the same origin. In `next dev` only, /api is proxied to DESK_API_URL. */
const config = {
  ...(dev
    ? { rewrites: async () => [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }] }
    : { output: 'export' }),
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
};
export default config;
