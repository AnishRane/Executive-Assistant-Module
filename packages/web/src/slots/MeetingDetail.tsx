// Legacy /executive/meetings/:id route. Post-0.4.0 the drilldown
// lives in a right-side drawer on /executive (controlled via the
// `?meeting=<id>` search param). This slot stays only so external
// bookmarks resolve — it redirects to the drawer form.

import { useParams, Navigate } from "react-router-dom";

export function MeetingDetail() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/executive" replace />;
  return <Navigate to={`/executive?meeting=${id}`} replace />;
}
