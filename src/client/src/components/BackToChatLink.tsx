// Shared chrome between the admin and profile views (issue #95): both mount
// as full views at their own URL with this absolute link back to the chat.
const BackToChatLink = () => (
  <div className="absolute right-4 top-4 z-10 flex flex-col items-start gap-2">
    <a
      href="/"
      className="text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
    >
      Back to chat
    </a>
  </div>
);

export default BackToChatLink;
