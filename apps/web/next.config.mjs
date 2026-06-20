/** @type {import("next").NextConfig} */
const nextConfig = {
  transpilePackages: ["@expertmesh/contracts", "@expertmesh/domain", "@expertmesh/sdk", "@expertmesh/utils"]
};

export default nextConfig;
