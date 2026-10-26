import { NewsCardEditor } from "../../components/NewsCardEditor/NewsCardEditor";

export function CardEditPage({ id }) {
  return (
    <div className="pageStack">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <a href="#/library">Manage news</a> <span aria-hidden="true">/</span>{" "}
        <span>Card</span>
      </nav>
      <NewsCardEditor key={id} cardId={id} />
    </div>
  );
}
