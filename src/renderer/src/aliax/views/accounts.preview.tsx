import { Page } from "@renderer/components/page";
import { AccountsView, type AccountsViewProps } from "./accounts";

/**
 * The Accounts page's frame around its view, drawn with no snapshot, for
 * `bun run ui:preview src/renderer/src/aliax/views/accounts.preview.tsx#AccountsPagePreview
 * --width 1400`: the page at the pane's width, so the table and the stacked
 * form show at the widths they ship at. Rendered by nothing in the app.
 */
export function AccountsPagePreview(props: AccountsViewProps) {
  return (
    <Page title="Accounts" description="The sign-ins and keys threads route through." width="table">
      <AccountsView {...props} />
    </Page>
  );
}
