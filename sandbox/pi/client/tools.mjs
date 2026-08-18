const tools = {
  read: "read,grep,find,ls",
  write: "read,write,edit,bash,grep,find,ls",
};

export function sessionTools(profile = "read") {
  const selected = tools[profile];
  if (!selected) throw new Error(`Unsupported Session profile '${profile}'`);
  return selected;
}
