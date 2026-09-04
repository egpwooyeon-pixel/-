import { POSTS as MILLI_POSTS } from "./milliclinic/posts";

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://project-2-10f6.vercel.app";

export default function sitemap() {
  const now = new Date();

  const staticRoutes = ["", "/blog", "/milliclinic"].map((path) => ({
    url: `${BASE_URL}${path}`,
    lastModified: now,
  }));

  const milliRoutes = MILLI_POSTS.map((post) => ({
    url: `${BASE_URL}/milliclinic/${post.slug}`,
    lastModified: now,
  }));

  return [...staticRoutes, ...milliRoutes];
}
