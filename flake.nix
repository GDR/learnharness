{
  description = "LearnHarness: An agent harness for learning: adaptive teaching, practice, and a persistent knowledge graph";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "aarch64-darwin" "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      pkgsFor = nixpkgs.legacyPackages;
    in {
      packages = forAllSystems (system:
        let
          pkgs = pkgsFor.${system};
          pkgJson = builtins.fromJSON (builtins.readFile ./package.json);
          pname = pkgJson.name;
          version = pkgJson.version;

          darwinPkg = pkgs.stdenv.mkDerivation {
            inherit pname version;

            src = pkgs.fetchurl {
              url = "https://github.com/GDR/learnharness/releases/download/v${version}/LearnHarness-${version}-arm64-mac.zip";
              hash = "sha256-2yE01hPf0h56dyZO9Z3o9Ak1qPN+qXqnGt4eC+olXIY=";
            };

            nativeBuildInputs = [
              pkgs.unzip
              pkgs.makeWrapper
              pkgs.darwin.sigtool
            ];

            sourceRoot = ".";
            unpackCmd = "unzip -q $curSrc";
            dontConfigure = true;
            dontBuild = true;
            dontFixup = true;

            installPhase = ''
              runHook preInstall

              mkdir -p "$out/Applications" "$out/bin"
              cp -a "LearnHarness.app" "$out/Applications/"
              chmod -R u+w "$out/Applications/LearnHarness.app/Contents"
              rm -rf "$out/Applications/LearnHarness.app/Contents/_CodeSignature" \
                     "$out/Applications/LearnHarness.app/Contents/CodeResources"
              codesign -f -s - "$out/Applications/LearnHarness.app/Contents/MacOS/LearnHarness"
              makeWrapper "$out/Applications/LearnHarness.app/Contents/MacOS/LearnHarness" "$out/bin/learnharness"

              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = pkgJson.description;
              homepage = "https://github.com/GDR/learnharness";
              license = licenses.agpl3Only;
              platforms = [ "aarch64-darwin" ];
              mainProgram = "learnharness";
            };
          };

          linuxPkg =
            let
              src = pkgs.fetchurl {
                url = "https://github.com/GDR/learnharness/releases/download/v${version}/LearnHarness-${version}-x86_64.AppImage";
                hash = "sha256-7zRlGDOxGOpcdEnM2UUFgBB66xg+bHGrFQdrQ7xFGOw=";
              };
              extracted = pkgs.appimageTools.extract { inherit pname version src; };
            in
            pkgs.appimageTools.wrapAppImage {
              inherit pname version;
              src = extracted;

              extraInstallCommands = ''
                install -m 444 -D ${extracted}/learnharness.desktop -t $out/share/applications
                substituteInPlace $out/share/applications/learnharness.desktop \
                  --replace-fail 'Exec=AppRun --no-sandbox %U' 'Exec=learnharness %U'
                cp -r ${extracted}/usr/share/icons $out/share
              '';

              meta = with pkgs.lib; {
                description = pkgJson.description;
                homepage = "https://github.com/GDR/learnharness";
                license = licenses.agpl3Only;
                platforms = [ "x86_64-linux" ];
                mainProgram = "learnharness";
              };
            };
        in {
          learnharness = if pkgs.stdenv.hostPlatform.isDarwin then darwinPkg else linuxPkg;
          default = self.packages.${system}.learnharness;
        }
      );

      apps = forAllSystems (system: {
        learnharness = {
          type = "app";
          program = "${self.packages.${system}.learnharness}/bin/learnharness";
        };
        default = self.apps.${system}.learnharness;
      });

      devShells = forAllSystems (system: {
        default = pkgsFor.${system}.mkShell {
          buildInputs = [
            pkgsFor.${system}.nodejs_24
          ];
        };
      });

      overlays.default = final: _prev: {
        learnharness = self.packages.${final.stdenv.hostPlatform.system}.learnharness;
      };

      homeManagerModules.learnharness = { config, lib, pkgs, ... }:
        let
          cfg = config.programs.learnharness;
          isDarwin = pkgs.stdenv.hostPlatform.isDarwin;

          modelSlotType = lib.types.submodule {
            options = {
              provider = lib.mkOption {
                type = lib.types.str;
                description = "Provider ID (e.g. 'antigravity', 'anthropic', 'openai', 'openrouter').";
              };
              id = lib.mkOption {
                type = lib.types.str;
                description = "Model ID within the provider.";
              };
              thinkingLevel = lib.mkOption {
                type = lib.types.nullOr (lib.types.enum [ "off" "minimal" "low" "medium" "high" "xhigh" "max" ]);
                default = null;
                description = "Optional thinking budget level.";
              };
            };
          };

          mkSlotAttr = slot:
            if slot == null then null
            else {
              model = { inherit (slot) provider id; };
            } // lib.optionalAttrs (slot.thinkingLevel != null) {
              inherit (slot) thinkingLevel;
            };

          modelsAttrs = lib.filterAttrs (_: v: v != null) {
            strong = mkSlotAttr cfg.models.strong;
            cheap = mkSlotAttr cfg.models.cheap;
            vision = mkSlotAttr cfg.models.vision;
          };

          agentAttrs = lib.filterAttrs (_: v: v != null && v != { } && v != [ ]) {
            obsidianFolders = cfg.obsidianFolders;
            tools = cfg.tools;
            search = if cfg.searchEngine != null then { engine = cfg.searchEngine; } else null;
            graphTools = if cfg.graphTools != null then { enabled = cfg.graphTools; } else null;
          };

          appearanceAttrs = lib.filterAttrs (_: v: v != null) {
            inherit (cfg.appearance) mode background fontFamily proseFontSize sessionNameSerif;
          };

          graphAttrs = lib.filterAttrs (_: v: v != null) {
            inherit (cfg.graph) enabled rendering extractionChunkTokens;
          };

          compactionAttrs = lib.filterAttrs (_: v: v != null) {
            thresholdTokens = cfg.compaction.thresholdTokens;
          };

          # Non-obvious: LearnHarness updates data/settings.json in place via fs.writeFileSync
          # when the user changes models or settings in the UI. We deep-merge declarative settings
          # via jq in a Home Manager activation script rather than symlinking into /nix/store,
          # keeping settings.json mutable at runtime.
          declarativeSettings = lib.recursiveUpdate (lib.filterAttrs (_: v: v != null && v != { }) {
            version = 1;
            general = { autoUpdate = cfg.autoUpdate; };
            models = if modelsAttrs != { } then modelsAttrs else null;
            agent = if agentAttrs != { } then agentAttrs else null;
            appearance = if appearanceAttrs != { } then appearanceAttrs else null;
            graph = if graphAttrs != { } then graphAttrs else null;
            compaction = if compactionAttrs != { } then compactionAttrs else null;
          }) cfg.extraSettings;

          settingsJsonFile = pkgs.writeText "learnharness-declarative-settings.json" (builtins.toJSON declarativeSettings);

          settingsPath =
            if isDarwin
            then "$HOME/Library/Application Support/LearnHarness/data/settings.json"
            else "${config.xdg.configHome}/LearnHarness/data/settings.json";
        in
        {
          options.programs.learnharness = {
            enable = lib.mkEnableOption "LearnHarness adaptive learning agent harness";

            package = lib.mkOption {
              type = lib.types.nullOr lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.learnharness;
              description = "LearnHarness package to install.";
            };

            autoUpdate = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "Whether LearnHarness should check for automatic updates (default false under Nix).";
            };

            obsidianFolders = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              example = [ "~/obsidian-vault" ];
              description = "Obsidian vault/project folder paths where agent Markdown write/edit tools are allowed to operate.";
            };

            models = {
              strong = lib.mkOption {
                type = lib.types.nullOr modelSlotType;
                default = null;
                description = "Strong model slot (used by prober and teacher agents).";
              };
              cheap = lib.mkOption {
                type = lib.types.nullOr modelSlotType;
                default = null;
                description = "Cheap/fast model slot (used by researcher, demoBuilder, extractor, auditor).";
              };
              vision = lib.mkOption {
                type = lib.types.nullOr modelSlotType;
                default = null;
                description = "Vision model slot (used by visualMaker and pdfReader).";
              };
            };

            tools = lib.mkOption {
              type = lib.types.attrsOf lib.types.bool;
              default = { };
              description = "Per-tool enable/disable overrides (absent = enabled).";
            };

            searchEngine = lib.mkOption {
              type = lib.types.nullOr (lib.types.enum [ "brave" "exa" "perplexity" "serper" "tavily" ]);
              default = null;
              description = "Preferred web search engine when multiple search API keys are configured.";
            };

            graphTools = lib.mkOption {
              type = lib.types.nullOr lib.types.bool;
              default = null;
              description = "Whether prober knowledge-graph inspection tools are enabled.";
            };

            appearance = {
              mode = lib.mkOption {
                type = lib.types.nullOr (lib.types.enum [ "dark" "light" ]);
                default = null;
                description = "Color mode ('dark' or 'light').";
              };
              background = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Custom hex background color (e.g. '#191724').";
              };
              fontFamily = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Main reading font family name.";
              };
              proseFontSize = lib.mkOption {
                type = lib.types.nullOr lib.types.int;
                default = null;
                description = "Reading font size in px (12–24).";
              };
              sessionNameSerif = lib.mkOption {
                type = lib.types.nullOr lib.types.bool;
                default = null;
                description = "Render session names in CMU Serif.";
              };
            };

            graph = {
              enabled = lib.mkOption {
                type = lib.types.nullOr lib.types.bool;
                default = null;
                description = "Master switch for knowledge graph extraction and auditing.";
              };
              rendering = lib.mkOption {
                type = lib.types.nullOr lib.types.bool;
                default = null;
                description = "Whether the home screen renders the interactive knowledge graph canvas.";
              };
              extractionChunkTokens = lib.mkOption {
                type = lib.types.nullOr lib.types.int;
                default = null;
                description = "Uncovered transcript token budget before an extraction batch fires (>= 500).";
              };
            };

            compaction = {
              thresholdTokens = lib.mkOption {
                type = lib.types.nullOr lib.types.int;
                default = null;
                description = "Context token threshold before automatic conversation compaction (>= 32000).";
              };
            };

            extraSettings = lib.mkOption {
              type = lib.types.attrsOf lib.types.anything;
              default = { };
              description = "Additional raw settings deep-merged into settings.json.";
            };
          };

          config = lib.mkIf cfg.enable {
            home.packages = lib.mkIf (cfg.package != null) [ cfg.package ];

            home.activation.learnharnessSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
              settings_file="${settingsPath}"
              mkdir -p "$(dirname "$settings_file")"
              if [ -f "$settings_file" ] && [ ! -L "$settings_file" ]; then
                ${pkgs.jq}/bin/jq -s '.[0] * .[1]' "$settings_file" "${settingsJsonFile}" > "$settings_file.tmp" \
                  && mv "$settings_file.tmp" "$settings_file"
              else
                rm -f "$settings_file"
                cp "${settingsJsonFile}" "$settings_file"
                chmod u+w "$settings_file"
              fi
            '';
          };
        };

      homeManagerModules.default = self.homeManagerModules.learnharness;
    };
}
