import type { SimpleIcon } from 'simple-icons';
import {
  siAtlassian,
  siDropbox,
  siGithub,
  siGmail,
  siGooglecalendar,
  siGooglemaps,
  siGoogledrive,
  siLinear,
  siNotion,
  siSpotify,
  siTrello,
} from 'simple-icons';

// Simple-icons SVG when the slug exists, a brand-colored letter tile otherwise (some brands are not in simple-icons).
// @see #331

const BY_SLUG: Record<string, SimpleIcon> = {
  googledrive: siGoogledrive,
  gmail: siGmail,
  googlecalendar: siGooglecalendar,
  googlemaps: siGooglemaps,
  spotify: siSpotify,
  dropbox: siDropbox,
  notion: siNotion,
  trello: siTrello,
  linear: siLinear,
  atlassian: siAtlassian,
  github: siGithub,
};

const ConnectorLogo = ({
  name,
  iconRef,
  brandColor,
  className = 'size-8',
}: {
  name: string;
  iconRef?: string;
  brandColor?: string;
  className?: string;
}) => {
  const icon = iconRef ? BY_SLUG[iconRef] : undefined;
  if (icon) {
    return (
      <span
        aria-hidden="true"
        className={`inline-flex items-center justify-center rounded-lg bg-muted p-1.5 ${className}`}
      >
        <svg role="img" viewBox="0 0 24 24" className="size-full" fill={`#${icon.hex}`}>
          <title>{icon.title}</title>
          <path d={icon.path} />
        </svg>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center rounded-lg text-sm font-semibold ${className}`}
      style={{ backgroundColor: `${brandColor ?? '#52525B'}1a`, color: brandColor ?? '#52525B' }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
};

export default ConnectorLogo;
