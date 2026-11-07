export interface ISyncTransport {
  readonly type: string;
  send(localZipPath: string, dest: string): Promise<void>;
  receive(source: string, destDir: string): Promise<string>;
  ping(): Promise<boolean>;
}
