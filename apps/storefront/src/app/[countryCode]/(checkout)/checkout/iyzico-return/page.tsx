import { Metadata } from "next"
import IyzicoReturn from "@modules/checkout/components/iyzico-return"

export const metadata: Metadata = {
  title: "Finalizing payment",
}

export default function IyzicoReturnPage() {
  return <IyzicoReturn />
}
