import type { DistributionFeedValidationEvidence } from
  "./distribution-certification";

export const DIRECTORY_SUBMISSION_PACKET_VERSION = 1;

type DirectorySubmissionPacketShow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  language: string;
  artworkUrl: string | null;
  canonicalUrl: string;
  podcastGuid: string | null;
  authorName: string;
  category: string;
  explicit: boolean;
};

type DirectorySubmissionPacketDestination = {
  id: string;
  name: string;
  enabled: boolean;
  submissionUrl: string | null;
  ownerSetupStatus: string;
  listingUrl: string | null;
};

export type DirectorySubmissionPacket = {
  schema: "dust-wave-directory-submission-packet";
  version: number;
  containsCredentials: false;
  show: DirectorySubmissionPacketShow & {
    feedUrl: string;
    owner: {
      name: string;
      email: string;
    };
  };
  feedValidation: DistributionFeedValidationEvidence;
  destinations: DirectorySubmissionPacketDestination[];
};

export function buildDirectorySubmissionPacket({
  show,
  feedUrl,
  ownerName,
  ownerEmail,
  feedValidation,
  destinations
}: {
  show: DirectorySubmissionPacketShow;
  feedUrl: string;
  ownerName: string;
  ownerEmail: string;
  feedValidation: DistributionFeedValidationEvidence;
  destinations: DirectorySubmissionPacketDestination[];
}): DirectorySubmissionPacket {
  return {
    schema: "dust-wave-directory-submission-packet",
    version: DIRECTORY_SUBMISSION_PACKET_VERSION,
    containsCredentials: false,
    show: {
      ...show,
      feedUrl,
      owner: {
        name: ownerName,
        email: ownerEmail
      }
    },
    feedValidation: { ...feedValidation },
    destinations: destinations.map((destination) => ({
      id: destination.id,
      name: destination.name,
      enabled: destination.enabled,
      submissionUrl: destination.submissionUrl,
      ownerSetupStatus: destination.ownerSetupStatus,
      listingUrl: destination.listingUrl
    }))
  };
}
