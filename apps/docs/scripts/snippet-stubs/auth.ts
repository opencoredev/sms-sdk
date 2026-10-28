// Stand-in for the reader's auth library in doc snippets.
export async function getSession(_request: Request): Promise<{ userId: string } | null> {
  return null;
}
