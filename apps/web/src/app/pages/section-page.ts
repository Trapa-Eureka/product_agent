import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { toSignal } from "@angular/core/rxjs-interop";
import { map } from "rxjs";

/** A nav destination whose view lands in a later task; it says so instead of showing nothing. */
@Component({
  selector: "pca-section-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>{{ section() }}</h1>
    <p class="pending">This view lands with {{ lands() }}.</p>
  `,
  styles: `
    h1 {
      font-size: 18px;
      margin: 0 0 8px;
    }
    .pending {
      color: var(--muted);
    }
  `,
})
export class SectionPage {
  private readonly route = inject(ActivatedRoute);
  readonly section = toSignal(this.route.data.pipe(map((data) => String(data["section"] ?? ""))), {
    initialValue: "",
  });
  readonly lands = toSignal(this.route.data.pipe(map((data) => String(data["lands"] ?? ""))), {
    initialValue: "",
  });
}
