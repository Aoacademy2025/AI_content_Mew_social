import { redirect } from "next/navigation";

// Clerk handles forgot-password flow natively inside the SignIn component.
export default function ForgotPasswordPage() {
  redirect("/login");
}
