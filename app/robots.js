const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://project-2-10f6.vercel.app";

export default function robots() {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin"],
    },
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
