export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<boolean> {
  // Email sending not configured — log reset URL for manual recovery
  console.warn("[send-email] Email not configured. Reset URL for", to, ":", resetUrl);
  return false;
}
