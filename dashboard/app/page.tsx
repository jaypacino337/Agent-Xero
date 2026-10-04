"use client";
import { Flywheel } from "@/components/dash/Flywheel";
import { Footer } from "@/components/dash/Footer";
import { Hero } from "@/components/dash/Hero";
import { Ledger } from "@/components/dash/Ledger";
import { Rules } from "@/components/dash/Rules";
import { Tape } from "@/components/dash/Tape";
import { Topbar } from "@/components/dash/Topbar";
import { Treasury } from "@/components/dash/Treasury";
import { useLive } from "@/components/dash/useLive";

export default function Dashboard() {
  const { data, lastSync, offline } = useLive();
  return (
    <>
      <Topbar data={data} lastSync={lastSync} offline={offline} />
      <main>
        <Hero data={data} />
        <Tape data={data} />
        <Treasury data={data} />
        <Flywheel data={data} />
        <Ledger data={data} />
        <Rules />
      </main>
      <Footer />
    </>
  );
}
