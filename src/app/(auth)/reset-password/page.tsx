import { redirect } from "next/navigation";

// Clerk handles password reset natively via email links.
export default function ResetPasswordPage() {
  redirect("/login");
}
