import { POSTS } from "./posts";

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://project-2-10f6.vercel.app";

export default function sitemap() {
  const now = new Date();

  const homeRoute = { url: BASE_URL, lastModified: now };

  const postRoutes = POSTS.map((post) => ({
    url: `${BASE_URL}/${post.slug}`,
    lastModified: now,
  }));

  return [homeRoute, ...postRoutes];
}
