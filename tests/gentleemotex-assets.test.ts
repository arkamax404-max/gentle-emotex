import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { avatarNames, findAvatar } from "../src/avatar_selection.ts";
import { decodePng } from "../src/png.ts";

const ROOT = join(import.meta.dirname, "..");
const SET = join(ROOT, "emotes", "gentleemotex");

const EXPECTED_FILES = [
  "ask/ask_1.png",
  "ask/ask_2.png",
  "build/build_1.png",
  "build/build_2.png",
  "build/build_3.png",
  "bye/bye_1.png",
  "bye/bye_2.png",
  "bye/in_1.png",
  "bye/in_2.png",
  "compact/compact_1.png",
  "compact/compact_2.png",
  "compact/compact_3.png",
  "delegate/delegate_1.png",
  "delegate/delegate_2.png",
  "delegate/delegate_3.png",
  "emotes.json",
  "explore/explore_1.png",
  "explore/explore_2.png",
  "explore/explore_3.png",
  "failure/failure_1.png",
  "failure/failure_2.png",
  "failure/failure_3.png",
  "grandma/in_1.png",
  "grandma/in_2.png",
  "grandma/in_3.png",
  "grandma/knit_1.png",
  "grandma/knit_2.png",
  "grandma_old/in_1.png",
  "grandma_old/in_2.png",
  "grandma_old/in_3.png",
  "grandma_old/knit_1.png",
  "grandma_old/knit_2.png",
  "hi/in_1.png",
  "hi/in_2.png",
  "hi/in_3.png",
  "hi/in_4.png",
  "hi/in_5.png",
  "hi/in_6.png",
  "hi/landed_1.png",
  "hi/landed_2.png",
  "idle/idle.png",
  "idle/idle_blink.png",
  "jira/jira_1.png",
  "jira/jira_2.png",
  "jira/jira_3.png",
  "jobs/jobs_1.png",
  "jobs/jobs_2.png",
  "jobs/jobs_3.png",
  "judge/judge_1.png",
  "judge/judge_2.png",
  "read/read_1.png",
  "read/read_2.png",
  "read/read_3.png",
  "remember/remember_1.png",
  "remember/remember_2.png",
  "review/review_1.png",
  "review/review_2.png",
  "review/review_3.png",
  "review/review_4.png",
  "success/success_1.png",
  "success/success_2.png",
  "super-yolo/super-yolo.png",
  "super-yolo/super-yolo_blink.png",
  "talk/talk_close.png",
  "talk/talk_mid.png",
  "talk/talk_small.png",
  "talk/talk_wide.png",
  "think/think_1.png",
  "think/think_2.png",
  "tool/tool_1.png",
  "tool/tool_2.png",
  "tool/tool_3.png",
  "verify/fail.png",
  "verify/verify_1.png",
  "verify/verify_2.png",
  "verify/verify_3.png",
  "write/write_1.png",
  "write/write_2.png",
  "write/write_3.png",
  "write/write_4.png",
  "yolo/yolo.png",
  "yolo/yolo_blink.png",
];

function collect(set: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else files.push(rel);
    }
  };
  walk(set, "");
  return files.sort();
}

test("the imported gentleemotex set is discoverable through the public avatar selection", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gentleemotex-assets-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = join(root, "profile");
    const cwd = join(root, "project");
    assert.equal(findAvatar("gentleemotex", ROOT, cwd), SET,
      "the repository emotes layer exposes the set for /emote avatar gentleemotex");
    assert.ok(avatarNames(ROOT, cwd).includes("gentleemotex"), "tab completion lists the set");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Byte-for-byte golden hashes pinned from the approved asset import:
 * every entry is the exact SHA256 and size of the file as delivered,
 * checked directly against the bytes on disk with no runtime source,
 * manifest or Git history dependency.
 */
const GOLDEN_FILES: ReadonlyArray<readonly [file: string, sha256: string, bytes: number]> = [
  ["ask/ask_1.png", "9e3a670b0e91edc8d83e64d3e508733e27d1773ff22372702cdae40eb3b99743", 542],
  ["ask/ask_2.png", "a5c85c54924b5bc5e127cca1fc8c462592da3a8e7e77e8ae9cdbd0ffaab43855", 541],
  ["build/build_1.png", "45974a4d8d9cc0f726f8f40fd2b68265c4655e0e2f334de8bd338c68151f34b6", 608],
  ["build/build_2.png", "c8007b9f5019229f0adf7d6072f9b20fa54d593d5076bf2fcadd46a4f5ac2523", 580],
  ["build/build_3.png", "a3cd5ee4cc5aa77623bc9d1c6d1ba5407c36845366eb2dbe363cc6fa08aa2244", 580],
  ["bye/bye_1.png", "38f14052c76f263d607aad7f02f4e9e9c54235862c2658ebc8bdc3874e707475", 589],
  ["bye/bye_2.png", "d975f5f24007f63b3db1ee576c52032644288adac8eae12d57aebdae50a1ed7f", 601],
  ["bye/in_1.png", "53ac9c05e362ebebdd0ee372b326dc33e3f92830433e72d0253e23c704f51d86", 494],
  ["bye/in_2.png", "fec81954b94cdfa994fd52a4c0d7476207b23f85a5ceb5f0d77c8323cb03af4e", 516],
  ["compact/compact_1.png", "7f7701e7c995d37f9d562534845ec0ddde377ac55f582326af5b15d72a4eff95", 456],
  ["compact/compact_2.png", "d8ad5ea6b6f674d394eb8d3f5ece210f4dd169e947a22e25c959a8bc655cc498", 340],
  ["compact/compact_3.png", "5104ba0e52d5f90183c31ec2542341ba79f40b9f69ade6ac5a139deb4d212fe5", 272],
  ["delegate/delegate_1.png", "5f7796a381bdae089352c87ff3299f1cee966904cd444e4952fb2ba72433bc82", 635],
  ["delegate/delegate_2.png", "9c7a2b05134dc324dfada5fe6942a5e98f0564a57ce652220474eb249fb7b300", 643],
  ["delegate/delegate_3.png", "5f7796a381bdae089352c87ff3299f1cee966904cd444e4952fb2ba72433bc82", 635],
  ["emotes.json", "6c9adc9626f74542ef1ab507d6bbb125ee46a90f15050c8e64bf1d116ebd207a", 1166],
  ["explore/explore_1.png", "c1585e4041a284af899133eb191cb07fd245b23edd3e88975634cf780ec7e950", 610],
  ["explore/explore_2.png", "382d4977e7a28ba183cc9f009da1c3d26dec9f60536745c31309de931b118715", 601],
  ["explore/explore_3.png", "bf6783ac9ce0685c11a25ea6ecb05057f39d17fb2b00c431d7b41d11bf696c13", 614],
  ["failure/failure_1.png", "eafb2492de5e80a0aaa8cda050588d1ad07bf558e0bf8c268177739c089a9ea9", 565],
  ["failure/failure_2.png", "2da607a15039f3014e14cb47305246ed6a084e56ff6d8cd99c5decfa6316d2f4", 585],
  ["failure/failure_3.png", "73ba0a2fc6dc2acf393e8c71077021fed641f6b35460042fd1989793d8da65e3", 560],
  ["grandma/in_1.png", "e0b458739bc9c3b24301f19a1fab08d50a4565169281bb23ad828c8cccfb11d7", 408],
  ["grandma/in_2.png", "00dbf3a9c18f7e01395560c1a316327091f90f624c9f19d46a7887ba24fd28a9", 290],
  ["grandma/in_3.png", "de271a8d0e3be1d665bfee9f6038085d6e92f0e276d419429eb71e37c369c08b", 1758],
  ["grandma/knit_1.png", "288c284ac0909a680507f4b72bcaa8998b70b8a67e540537a5511387e30080ac", 1327],
  ["grandma/knit_2.png", "d88ff98dc8067c9fbdf0a1b34a58f10ef4fc612ba20fe8433be3233d1b6482de", 1321],
  ["grandma_old/in_1.png", "e0b458739bc9c3b24301f19a1fab08d50a4565169281bb23ad828c8cccfb11d7", 408],
  ["grandma_old/in_2.png", "00dbf3a9c18f7e01395560c1a316327091f90f624c9f19d46a7887ba24fd28a9", 290],
  ["grandma_old/in_3.png", "c267d194e4d3e1ed8f45ee76df9f0c3fc020d788295e4e401d3d2f1043f110e2", 549],
  ["grandma_old/knit_1.png", "3eff99fb4d0e8814b50b61d8f934f7629eb6fa489e738c0cb322dbe4d44b0efb", 647],
  ["grandma_old/knit_2.png", "cf529f195b366ac3a060e975bd9c3ee7a1cd2ad57603378c315b6219e608c735", 646],
  ["hi/in_1.png", "8a82a0c4526309491ad43f5cb6e5cec546e47e6502587137b181291d2a58109c", 489],
  ["hi/in_2.png", "d319465251b7c05bb3649749690941606eb82fc79188171354ff74118b78b5e4", 500],
  ["hi/in_3.png", "0c446d4db7c53f962129c52c2a73683348dedebf227745ac722cbd79fc770fb2", 496],
  ["hi/in_4.png", "27d62265bfcb2ac0553e4839173f7737952fa310b38d29461953d4ebc6a2a774", 526],
  ["hi/in_5.png", "85db231328b5d37d914461f39455321c86f406c9deb58355e822c1107c90d2be", 536],
  ["hi/in_6.png", "df5568b6095bcc07a9b7295c9298ea658e15b08898239b6ead87ba80c135e73a", 566],
  ["hi/landed_1.png", "0fed134e9e9151b1de7214f9847069ee5fcf5afeed78c9d24f217cfa32503867", 562],
  ["hi/landed_2.png", "e012be25054d3d83786dc3bc512661d7d79d15eb974dc73d861f21ab49c2f29d", 567],
  ["idle/idle.png", "7f7701e7c995d37f9d562534845ec0ddde377ac55f582326af5b15d72a4eff95", 456],
  ["idle/idle_blink.png", "4582d6e2982d1085399a29b41443ea16d9efb3af8b61a106d9830272c5667a09", 448],
  ["jira/jira_1.png", "02a5f1087cbc659b2b7518020672597df32b4e7c7bdc2dd9dfa127b0d60c8995", 553],
  ["jira/jira_2.png", "ff7f0232b6aef76bd48e63f47d861056768e548668e10492bfca10aee233c6d8", 551],
  ["jira/jira_3.png", "2a551cbe3e6e28f26810c9ad90e965350245bd69b353f4f3e46241b2f9a0d60c", 572],
  ["jobs/jobs_1.png", "9d2096b0e5fa24327d6caa179ea97dd6b87da27b6241168ac0f7147efd77e96f", 583],
  ["jobs/jobs_2.png", "ac047dbbac4948c5bc4e03f902fb28424fe7ce0d45ac7a43ead4862363187f86", 566],
  ["jobs/jobs_3.png", "5eb119cc3eb83d89e9369ab5988731991e0d2b065db1d3493aebad99bc0bd04f", 570],
  ["judge/judge_1.png", "e1865b4bdf8b73702ebd88c512e58df8c37038690055d9c199e25955cd457a88", 547],
  ["judge/judge_2.png", "8918890bda4595cd49595b1334d7cf203fdfc7ecb4b7e7d1623513e8ca91ea43", 559],
  ["read/read_1.png", "9e80d0507c6b7744df624151f2c5713aca782eb2677fe767e9e662b910280d7f", 526],
  ["read/read_2.png", "ef3d5eaf6727a71f62faa42e4a7b3143dd42d4fd504ad55c76546cfda72b0cbc", 556],
  ["read/read_3.png", "f44cda093e6a94eab3595b7bd0a1dac791929cc61964235c800042deadc56328", 562],
  ["remember/remember_1.png", "ea65fe39b4d4860f33200a1117ccc8cf5ba784b21eeb72a11d23da8e5495854f", 583],
  ["remember/remember_2.png", "9fa125682f9b3a9a4406f5bee5989dc31b7f4add0d21b29385939d3eceb774e8", 594],
  ["review/review_1.png", "61ee5fb0b8fb409895e81bf58e624d6f7903d1390646493998dbdd4b8e557d4c", 672],
  ["review/review_2.png", "40be6aeb5a4f1f60e2fc615f9caf30671b1eee05ef627d8c531f52cc9573ce84", 648],
  ["review/review_3.png", "934bc557cd6ff64edb18807ea5c5eeed45e7463aac565cb9a5dfeb6adf602b6d", 667],
  ["review/review_4.png", "e034fcbc7c22c97fb61d23a96f1688dd6c0b14fc2c4d50cae9ede09b0e42fe43", 667],
  ["success/success_1.png", "9e7c1bf77fb87d3e5035350d54eb6755619cc2420515d535d152f3540ed05e40", 456],
  ["success/success_2.png", "c21d00249519106289033dcd568cd47350e97529507a4659f75806d78e6c2c8a", 547],
  ["super-yolo/super-yolo.png", "ff5fb668cfd8892b365712ee6d9deff92eaafba1b290f0dd6ddeb551c47c6b7e", 504],
  ["super-yolo/super-yolo_blink.png", "b5f6f129f81c91273e20de131ea5b135d072b81e6418018e6007c60ec8fc02cf", 510],
  ["talk/talk_close.png", "0160681c99700b1515977fd952050d58094a021b97dcfc21c543675c83c20553", 588],
  ["talk/talk_mid.png", "f23b783470baf9983b2c20bb894cbf126775a43a08dbb02931ebda22914949a3", 605],
  ["talk/talk_small.png", "4b324e0c28db79e4fd481f330f1187308a70054ad7dd7c1fe7ce8d5781e1bf9d", 596],
  ["talk/talk_wide.png", "f26c912146c8e092aaf80584ac8ef6d3c5ea369c2b998125be2722ad07307e2d", 614],
  ["think/think_1.png", "3b279413b7615be10415389cc0e770ee9128b8273326c6f73f53f379eead60c2", 463],
  ["think/think_2.png", "8a5845edd081692329b001263d8517d7f9aba6bf21261a180dc993a56497b1dd", 471],
  ["tool/tool_1.png", "13aba6d01fa934597f611f89284bd49b8e004dd24eb216c215216cac5fa11f8b", 612],
  ["tool/tool_2.png", "de249cb980546a908a02426ce3b5092305bd78d205dd48f906e9899e837a0b6e", 684],
  ["tool/tool_3.png", "38510e21a4718e776d702c3598940f43460c13b0d3a68fbfdde56413b3c9e63e", 611],
  ["verify/fail.png", "0385799c5bf6d5e27f1e2226cf7a929d7b054fb5b6b18be373c3fe08b5bf1210", 589],
  ["verify/verify_1.png", "c601aec02897c724db589e091c499a3a460e2c69e616cf1fe912279262c9ca8c", 608],
  ["verify/verify_2.png", "24ac7fd5d9b826f0fd2f7b56187075b3aad3bdecabb69cc93c42cc4b654bc90c", 606],
  ["verify/verify_3.png", "27fd12791d7898fc8f7db89f7b626905b4848eb3fed4bcf131151fe37f38d463", 588],
  ["write/write_1.png", "6457690c03eef5cb4ee3c51876cc79ca32a0b9b6b13cfc1c0f9d69920b0ec99e", 559],
  ["write/write_2.png", "4d0569a449d72d05b7ee24f759da6ff4bb494653a9e15ec5bae771f566ecf897", 573],
  ["write/write_3.png", "5ec97fe55a20d71e1521a475681b2423d87e8ebf036af1432c29a7c8c267cba2", 579],
  ["write/write_4.png", "129d610a1039fcc38a76d51aaba106f4ca40932019fe16d17cf6016d1eaebfdf", 581],
  ["yolo/yolo.png", "852f2faf87e68be3b130c29f63d2d29c820dfcb69e7f90c27462fd596dd19af2", 562],
  ["yolo/yolo_blink.png", "44b5b96494e751ae51a96ea59e06fb1b9212ab84c6ea592f8109e25c36ea6103", 560],
];

test("every imported gentleemotex file keeps its exact approved bytes: static SHA256 goldens", () => {
  assert.equal(GOLDEN_FILES.length, 82, "one golden per imported file");
  const actual = collect(SET);
  assert.deepEqual(
    actual,
    GOLDEN_FILES.map(([file]) => file),
    "the hashed set is exactly the imported inventory",
  );
  for (const [file, sha256, bytes] of GOLDEN_FILES) {
    const data = readFileSync(join(SET, file));
    assert.equal(data.length, bytes, `approved byte count: ${file}`);
    assert.equal(createHash("sha256").update(data).digest("hex"), sha256,
      `approved bytes: ${file}`);
  }
});

test("the imported gentleemotex set is complete: every frame decodes 48x40 with binary alpha", () => {
  const actual = collect(SET);
  assert.deepEqual(actual, EXPECTED_FILES, "the set keeps its exact imported inventory");
  assert.equal(actual.filter((file) => file.endsWith(".png")).length, 81);

  const stateDirs = readdirSync(SET, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(stateDirs, [
    "ask", "build", "bye", "compact", "delegate", "explore", "failure", "grandma",
    "grandma_old", "hi", "idle", "jira", "jobs", "judge", "read", "remember",
    "review", "success", "super-yolo", "talk", "think", "tool", "verify", "write", "yolo",
  ], "grandma_old stays verbatim as an inert extra state");

  for (const file of actual) {
    if (!file.endsWith(".png")) continue;
    const png = decodePng(readFileSync(join(SET, file)));
    assert.deepEqual([png.width, png.height], [48, 40], file);
    for (let i = 3; i < png.data.length; i += 4) {
      assert.ok(png.data[i] === 0 || png.data[i] === 255, `binary alpha: ${file}`);
    }
  }

  const files = new Set(actual);
  const metadata = JSON.parse(readFileSync(join(SET, "emotes.json"), "utf8"));
  const references = [
    metadata.idle?.default, metadata.idle?.blink,
    ...Object.keys(metadata.talk?.weights ?? {}),
  ].filter((name) => typeof name === "string") as string[];
  assert.ok(references.length > 0, "emotes.json names its special frames");
  for (const name of references) {
    assert.ok(files.has(`idle/${name}`) || files.has(`talk/${name}`) || files.has(name),
      `emotes.json reference resolves: ${name}`);
  }
});
