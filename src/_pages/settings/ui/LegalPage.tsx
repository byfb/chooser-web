// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import styles from "./LegalPage.module.css";

interface LegalPageProps {
  onBack(): void;
  release: {
    readonly kind: "candidate" | "development" | "production";
    readonly revision: string | null;
    readonly sourceArchivePath: string | null;
    readonly sourceUrl: string | null;
  };
}

const LOCAL_DOCUMENTS = [
  { href: "/legal/gpl-3.0.txt", label: "GPL-3.0 license text" },
  { href: "/legal/notice.txt", label: "Program notices" },
  { href: "/legal/third-party-notices.txt", label: "Third-party notices" },
  { href: "/legal/asset-provenance.txt", label: "Asset provenance" },
] as const;

export function LegalPage({ onBack, release }: LegalPageProps) {
  return (
    <main
      aria-labelledby="legal-title"
      className={`settings-route ${styles.page}`}
      data-route="legal"
      data-route-focus
      tabIndex={-1}
    >
      <header className={`settings-app-bar ${styles.appBar}`}>
        <button
          aria-label="Back to Settings"
          className={`route-back-button ${styles.backButton}`}
          onClick={onBack}
          type="button"
        >
          <span aria-hidden="true">←</span>
        </button>
        <h1 id="legal-title">Legal</h1>
      </header>

      <article className={styles.content}>
        <section aria-labelledby="legal-about-title" className={styles.section}>
          <h2 id="legal-about-title">Chooser Web</h2>
          <p className={styles.lede}>Web adaptation; modified 2026.</p>
          <ul className={styles.attributionList}>
            <li>Copyright (C) 2026 byfb</li>
            <li>
              Original Chooser: Copyright (C) 2025 UrAvgCode; contributor:
              Patch4Code.
            </li>
          </ul>
        </section>

        <section
          aria-labelledby="legal-license-title"
          className={styles.section}
        >
          <h2 id="legal-license-title">License</h2>
          <p>
            Chooser Web is free software under GPL-3.0-or-later. You may copy,
            modify, and redistribute it, and run or study the program while
            preserving the license and required notices.
          </p>
          <p>
            <strong>No warranty:</strong> this program is provided without
            warranty, to the extent permitted by applicable law. Use it at your
            own risk.
          </p>
          <p className={styles.linkRow}>
            <a className={styles.documentLink} href="/legal/gpl-3.0.txt">
              Read the complete GPL-3.0-or-later text
            </a>
          </p>
        </section>

        <section
          aria-labelledby="legal-upstream-title"
          className={styles.section}
        >
          <h2 id="legal-upstream-title">Original project</h2>
          <p>
            The behavior and visual concepts are adapted from the original
            Chooser project.
          </p>
          <p className={styles.linkRow}>
            <a
              className={styles.externalLink}
              href="https://github.com/UrAvgCode/Chooser"
            >
              Open the upstream Chooser repository
            </a>
          </p>
        </section>

        <section
          aria-labelledby="legal-release-title"
          className={styles.section}
        >
          <h2 id="legal-release-title">Release information</h2>
          <p className={styles.localBadge}>
            {release.kind === "production"
              ? "Production release"
              : release.kind === "candidate"
                ? "Local release candidate"
                : "Local development build"}
          </p>
          {release.kind === "production" ? (
            <p>
              This deployed build and its Corresponding Source identify the same
              immutable revision.
            </p>
          ) : (
            <p>
              This build has not been published as a production release. A
              public immutable source location still requires release approval.
            </p>
          )}
          <dl className={styles.metadata}>
            <div>
              <dt>Revision</dt>
              <dd>{release.revision ?? "Unavailable until release."}</dd>
            </div>
            <div>
              <dt>Corresponding source</dt>
              <dd>
                {release.sourceUrl ? (
                  <a className={styles.documentLink} href={release.sourceUrl}>
                    Download exact source
                  </a>
                ) : (
                  "Unavailable until a public immutable location is approved."
                )}
              </dd>
            </div>
            <div>
              <dt>Source archive</dt>
              <dd>
                {release.sourceArchivePath ? (
                  <a
                    className={styles.documentLink}
                    href={release.sourceArchivePath}
                  >
                    Download same-release archive
                  </a>
                ) : (
                  "Unavailable until release."
                )}
              </dd>
            </div>
          </dl>
        </section>

        <section
          aria-labelledby="legal-documents-title"
          className={styles.section}
        >
          <h2 id="legal-documents-title">License and notices</h2>
          <p>
            These records are included in this build and remain available after
            Offline reports Ready.
          </p>
          <ul className={styles.documentList}>
            {LOCAL_DOCUMENTS.map(({ href, label }) => (
              <li key={href}>
                <a className={styles.documentLink} href={href}>
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </section>
      </article>
    </main>
  );
}
