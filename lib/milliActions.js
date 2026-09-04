"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/auth";

const SLUG_RE = /^[a-z0-9-]+$/;

export async function loginMilliAction(formData) {
  const password = formData.get("password");

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    redirect("/milliclinic/admin/login?error=1");
  }

  const token = await createSessionToken();
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  redirect("/milliclinic/admin");
}

export async function logoutMilliAction() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  redirect("/milliclinic/admin/login");
}

function slugify(input) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function readPostFields(formData) {
  return {
    title: (formData.get("title") || "").toString().trim(),
    tag: (formData.get("tag") || "").toString().trim() || "밀리클리닉",
    excerpt: (formData.get("excerpt") || "").toString().trim(),
    headline: (formData.get("headline") || "").toString().trim(),
    content: (formData.get("content") || "").toString(),
    image: (formData.get("image") || "").toString() || null,
    author: (formData.get("author") || "").toString().trim() || "admin",
    published: formData.get("published") === "on",
  };
}

export async function createMilliPostAction(formData) {
  const fields = readPostFields(formData);

  if (!fields.title || !fields.content) {
    redirect("/milliclinic/admin/posts/new?error=1");
  }

  let slug = slugify((formData.get("slug") || "").toString()) || slugify(fields.title);
  if (!slug || !SLUG_RE.test(slug)) {
    redirect("/milliclinic/admin/posts/new?error=slug");
  }

  if (await prisma.milliPost.findUnique({ where: { slug } })) {
    redirect("/milliclinic/admin/posts/new?error=slug-taken");
  }

  await prisma.milliPost.create({
    data: { ...fields, slug, excerpt: fields.excerpt || fields.title },
  });

  redirect("/milliclinic/admin");
}

export async function updateMilliPostAction(id, formData) {
  const fields = readPostFields(formData);

  if (!fields.title || !fields.content) {
    redirect(`/milliclinic/admin/posts/${id}/edit?error=1`);
  }

  await prisma.milliPost.update({
    where: { id: Number(id) },
    data: { ...fields, excerpt: fields.excerpt || fields.title },
  });

  redirect("/milliclinic/admin");
}

export async function deleteMilliPostAction(id) {
  await prisma.milliPost.delete({ where: { id: Number(id) } });
  redirect("/milliclinic/admin");
}
