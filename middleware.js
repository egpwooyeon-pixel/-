import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

const ADMIN_ROOTS = ["/admin", "/milliclinic/admin"];

export async function middleware(request) {
  const { pathname } = request.nextUrl;

  const adminRoot = ADMIN_ROOTS.find((root) => pathname.startsWith(root));
  if (!adminRoot) return NextResponse.next();

  if (pathname.startsWith(`${adminRoot}/login`)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const valid = await verifySessionToken(token);
  if (!valid) {
    const loginUrl = new URL(`${adminRoot}/login`, request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/milliclinic/admin/:path*"],
};
