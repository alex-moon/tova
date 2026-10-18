// Shared chrome: admin and profile views mount full-page with this link back.
// @see #95
const BackToChatLink = () => (
  <div className="absolute right-4 top-0 z-10 flex h-14 flex-col items-start justify-center gap-2">
    <a
      href="/"
      className="text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
    >
      Back to chat
    </a>
  </div>
);

export default BackToChatLink;
