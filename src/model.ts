export type PageMeta = {
  threadId: string;
  title: string;
  createdAt: string;
  excerpt: string;
};

export type ArchivedMessage = {
  id: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  createdAt: string;
  content: string;
  replyTo: string | null;
  answer: boolean;
  reactions: { name: string; count: number }[];
};

export type ThreadSnapshot = PageMeta & {
  tags: string[];
  messages: ArchivedMessage[];
};

export type StoredThread = ThreadSnapshot & {
  published: boolean;
  sourceMissing: boolean;
};

export type Page = PageMeta & {
  html: string;
  assetPaths: readonly string[];
};
