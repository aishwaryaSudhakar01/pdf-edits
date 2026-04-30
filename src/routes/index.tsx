import { createFileRoute } from "@tanstack/react-router";
import PdfWorkspace from "@/components/PdfWorkspace";
import { ThemeModeProvider } from "@/lib/theme-context";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PDF Editor — Edit, Annotate, Redact & Sign PDFs" },
      {
        name: "description",
        content:
          "Free in-browser PDF editor: annotate, redact, crop, sign, merge, split, and rearrange PDF pages. Your files never leave your device.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <ThemeModeProvider>
      <PdfWorkspace />
    </ThemeModeProvider>
  );
}
